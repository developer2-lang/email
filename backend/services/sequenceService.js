/**
 * Sequence automation service.
 *
 * Data-access + workflow layer for the database-driven sequence feature.
 * Mirrors the campaign/follow-up architecture: the service owns the Supabase
 * queries for its tables and throws errors carrying an HTTP `status` that the
 * centralized Express error handler turns into a JSON error envelope.
 *
 * Canonical contact state lives in `sequence_enrollments`
 * (UNIQUE (sequence_id, contact_id), FK CASCADE on delete). Every step is a
 * NODE in a recursive branch tree:
 *
 *   sequence_steps.parent_step_id = the exact parent node (NULL = the
 *     STARTING step / Step 1), sequence_steps.parent_branch = 'opened' |
 *     'not_opened'. UNIQUE (sequence_id, parent_step_id, parent_branch) means
 *     one 'opened' + one 'not_opened' child per node. `step_number` is a
 *     display depth shared by siblings. Enrollments track the exact node via
 *     sequence_enrollments.current_step_id.
 *
 * There is NO Starting Campaign: the sequence itself sends Step 1 to every
 * enrolled recipient, then each branch advances to its configured next email.
 *
 * Audience labels and all counts are ALWAYS read from the database — nothing
 * here hardcodes campaign ids, names or audience labels.
 */
import {
  supabase,
  resolveContactsForAudience,
  deleteCampaign,
  isDeliverableRecipientEmail,
  normalizeEmail,
  hasTableColumn,
} from './supabaseService.js';
import {
  ensureSequenceCampaign,
  sendStepEmail,
  insertStepLog,
  emailTypeForNode,
  loadSequenceContext,
  evaluateNodeEligibility,
  getBranchEligibility,
  advanceAfterSend,
  checkDueEnrollments,
  stepDelayMs,
} from '../workers/sequenceWorker.js';
import { backfillStepLogEmailLinks, syncStepLogTrackingFromLinks } from './emailLogService.js';

const SEQUENCES_TABLE = 'sequences';
const STEPS_TABLE = 'sequence_steps';
const ENROLLMENTS_TABLE = 'sequence_enrollments';
const STEP_LOGS_TABLE = 'sequence_step_logs';
const BRANCH_STEPS_TABLE = 'sequence_branch_steps';

const TRIGGER_TYPES = ['manual', 'time_based', 'behaviour'];
const RECIPIENT_TYPES = ['all', 'opened', 'not_opened'];
const SEND_MODES = ['automatic', 'manual', 'both'];
// Per-step auto-send configuration (Sequence Builder).
const SEND_ACTIONS = ['send_email', 'send_automatically', 'skip'];
const SEND_AFTER_UNITS = ['minutes', 'hours', 'days'];

// Branch path values stored in sequence_steps.parent_branch (NOT NULL).
// The root/starting node is 'STARTING'; every child is 'OPENED' or 'NOT_OPENED'.
const BRANCH_STARTING = 'STARTING';
const BRANCH_OPENED = 'OPENED';
const BRANCH_NOT_OPENED = 'NOT_OPENED';
const BRANCHES = [BRANCH_OPENED, BRANCH_NOT_OPENED];

/** Normalize an incoming branch value to the canonical uppercase set. */
function normalizeBranch(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toUpperCase();
  return v === BRANCH_OPENED || v === BRANCH_NOT_OPENED || v === BRANCH_STARTING ? v : null;
}

const DEFAULT_WAIT_HOURS = 24;

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  return wrapped;
}

function notFound(kind, id) {
  const error = new Error(`${kind} not found${id ? `: ${id}` : ''}`);
  error.status = 404;
  throw error;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function requireString(value, name) {
  if (value === undefined || value === null || !String(value).trim()) {
    badRequest(`Missing required field: ${name}`);
  }
  return String(value).trim();
}

function enumValue(value, name, allowed) {
  const v = value === undefined || value === null ? undefined : String(value).trim();
  if (v !== undefined && !allowed.includes(v)) {
    badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

function waitHoursOf(step) {
  const h = Number(step && step.wait_hours);
  return Number.isFinite(h) && h >= 0 ? h : DEFAULT_WAIT_HOURS;
}

/** Display label for a step's send-after delay ('Immediate' | '2 days' | '36h'). */
function delayLabelOf(step) {
  if (!step) return 'Immediate';
  const v = Number(step.send_after_value);
  const unit = step.send_after_unit;
  if (Number.isFinite(v) && v > 0 && SEND_AFTER_UNITS.includes(unit)) {
    const per = unit === 'days' ? 'day' : unit === 'hours' ? 'h' : 'min';
    return `${v}${per}`;
  }
  const h = waitHoursOf(step);
  return h === 0 ? 'Immediate' : `${h}h`;
}

function startingNodeOf(steps) {
  return (steps || []).find((s) => s.parent_step_id === null) || (steps || [])[0] || null;
}

// ─── sequence_branch_steps mirror ───────────────────────────────────────────
//
// The Create/Edit Sequence form also persists its branch tree into the flat
// `sequence_branch_steps` table (sequence_id | step | parent_step |
// parent_branch | subject | body | wait_hours). Every step node saved to
// `sequence_steps` is mirrored here:
//   - OPENED / STARTING nodes write their normal subject+body,
//   - NOT_OPENED nodes write their increment subject+body,
//   - parent_step is the parent NODE's step_number (null for the root),
//   - wait_hours is the node's own wait (0 for OPENED children, the card's
//     wait for NOT_OPENED nodes).
// Rows are scoped by sequence_id and upserted by (sequence_id, step,
// parent_branch) so re-saving edited subject/body updates the existing row
// instead of creating duplicates. Mirror writes are best-effort: a failure
// here never blocks the canonical sequence_steps write (the sequence worker
// keeps reading sequence_steps, unchanged).

/** Derive the flat branch-step row a sequence_steps node maps to. */
async function branchStepRowForNode(sequenceId, node) {
  let parentStep = null;
  let parentStepId = null;
  if (node && node.parent_step_id) {
    const { data: parent } = await supabase
      .from(STEPS_TABLE)
      .select('step_number, parent_branch')
      .eq('id', node.parent_step_id)
      .eq('sequence_id', sequenceId)
      .maybeSingle();
    if (parent && parent.step_number != null) {
      parentStep = Number(parent.step_number);
      // The REAL parent reference is the parent node's mirror row id, so the
      // flat table can distinguish STEP 2 from STEP 2A (they share step_number
      // but are different rows).
      if (parent.parent_branch) {
        const { data: parentMirror } = await supabase
          .from(BRANCH_STEPS_TABLE)
          .select('id')
          .eq('sequence_id', sequenceId)
          .eq('step', Number(parent.step_number))
          .eq('parent_branch', parent.parent_branch)
          .maybeSingle();
        if (parentMirror) parentStepId = parentMirror.id;
      }
    }
  }
  const isNotOpened = node && node.parent_branch === BRANCH_NOT_OPENED;
  return {
    sequence_id: sequenceId,
    step: node && node.step_number != null ? Number(node.step_number) : null,
    parent_step: parentStep,
    parent_step_id: parentStepId,
    parent_branch: node ? node.parent_branch : null,
    subject: (isNotOpened ? (node.increment_subject || '') : (node.normal_subject || '')) || '',
    body: (isNotOpened ? (node.increment_body || '') : (node.normal_body || '')) || '',
    template_id: (isNotOpened
      ? (node.increment_template_id || null)
      : (node.normal_template_id || null)) || null,
    wait_hours: node && node.wait_hours != null ? Number(node.wait_hours) : 0,
    send_action: (node && node.send_action) || 'send_automatically',
    send_after_value:
      node && node.send_after_value != null ? Number(node.send_after_value) : null,
    send_after_unit: (node && node.send_after_unit) || null,
  };
}

/** Upsert one flat branch-step row keyed by (sequence_id, step, parent_branch). */
async function syncBranchStepForNode(sequenceId, node, options = {}) {
  try {
    const row = await branchStepRowForNode(sequenceId, node);
    if (row.step == null || !row.parent_branch) return;
    if (!options.includeEmpty && (!row.subject || !row.body)) return;
    if (!(await hasTableColumn(BRANCH_STEPS_TABLE, 'template_id'))) {
      delete row.template_id;
    }
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('id')
      .eq('sequence_id', row.sequence_id)
      .eq('step', row.step)
      .eq('parent_branch', row.parent_branch)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase
        .from(BRANCH_STEPS_TABLE)
        .update({
          parent_step: row.parent_step,
          parent_step_id: row.parent_step_id,
          subject: row.subject,
          body: row.body,
          template_id: row.template_id,
          wait_hours: row.wait_hours,
          send_action: row.send_action,
          send_after_value: row.send_after_value,
          send_after_unit: row.send_after_unit,
          updated_at: now,
        })
        .eq('id', existing.id);
      if (error) console.warn('[BranchSteps] update failed:', error.message);
    } else {
      const { error } = await supabase
        .from(BRANCH_STEPS_TABLE)
        .insert({ ...row, created_at: now, updated_at: now });
      if (error) console.warn('[BranchSteps] insert failed:', error.message);
    }
  } catch (err) {
    console.warn('[BranchSteps] sync failed:', err && err.message);
  }
}

/**
 * Make the flat sequence_branch_steps table a faithful projection of the
 * canonical sequence_steps tree for one sequence:
 *   - upsert one mirror row per ACTIVE (non-archived) step node (even nodes
 *     whose content is still empty), ordered by step_number so parent rows
 *     exist before their children and parent_step_id always resolves;
 *   - delete mirror rows that no longer map to an active node (e.g. leftovers
 *     from steps that were archived before the mirror existed).
 * Best-effort and idempotent — safe to call from read paths (getSequence,
 * listBranchSteps) so stale flat rows self-heal on load.
 */
async function reconcileBranchSteps(sequenceId, steps) {
  try {
    let active = steps;
    if (!active) {
      const { data, error } = await supabase
        .from(STEPS_TABLE)
        .select('*')
        .eq('sequence_id', sequenceId)
        .is('archived_at', null)
        .order('step_number', { ascending: true });
      if (error) throw error;
      active = data || [];
    }
    const activeKeys = new Set();
    for (const node of active || []) {
      if (node.step_number == null || !node.parent_branch) continue;
      activeKeys.add(`${Number(node.step_number)}|${node.parent_branch}`);
      await syncBranchStepForNode(sequenceId, node, { includeEmpty: true });
    }
    const { data: mirrorRows } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('id, step, parent_branch')
      .eq('sequence_id', sequenceId);
    for (const row of mirrorRows || []) {
      if (!activeKeys.has(`${Number(row.step)}|${row.parent_branch}`)) {
        const { error } = await supabase
          .from(BRANCH_STEPS_TABLE)
          .delete()
          .eq('id', row.id);
        if (error) console.warn('[BranchSteps] reconcile delete failed:', error.message);
      }
    }
  } catch (err) {
    console.warn('[BranchSteps] reconcile failed:', err && err.message);
  }
}

/**
 * Write a sequence_branch_steps edit back to its canonical sequence_steps node
 * so the email worker (which reads sequence_steps) and the Sequence page
 * reflect the change immediately. Content maps by branch: OPENED / STARTING
 * rows update normal_subject/normal_body, NOT_OPENED rows update
 * increment_subject/increment_body; wait_hours always applies to the node's
 * own wait.
 *
 * Structural moves (a row re-pointed at a different branch) are NOT written
 * through — the flat mirror is a projection of the canonical tree, so moving a
 * row belongs to the step API, not the mirror. When the branch changed we skip
 * rather than risk updating the wrong node.
 */
async function syncSequenceStepFromBranchStep(sequenceId, before, after) {
  if (!after || after.step == null || !after.parent_branch) return;
  if (before && before.parent_branch !== after.parent_branch) return;

  const { data: node, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('step_number', Number(after.step))
    .eq('parent_branch', after.parent_branch)
    .is('archived_at', null)
    .maybeSingle();
  if (error || !node) {
    console.warn(
      `[BranchSteps] write-through skipped: no sequence_steps node for step=${after.step} branch=${after.parent_branch} (${
        (error && error.message) || 'not found'
      })`
    );
    return;
  }

  const updates = {
    wait_hours: after.wait_hours != null ? Number(after.wait_hours) : Number(node.wait_hours),
    updated_at: new Date().toISOString(),
  };
  if (after.parent_branch === BRANCH_NOT_OPENED) {
    updates.increment_subject = after.subject;
    updates.increment_body = after.body;
    if (after.template_id !== undefined) {
      updates.increment_template_id =
        (await hasTableColumn(STEPS_TABLE, 'increment_template_id')) && after.template_id ? after.template_id : null;
    }
  } else {
    updates.normal_subject = after.subject;
    updates.normal_body = after.body;
    if (after.template_id !== undefined) {
      updates.normal_template_id =
        (await hasTableColumn(STEPS_TABLE, 'normal_template_id')) && after.template_id ? after.template_id : null;
    }
  }

  const { data: updatedNode, error: updateError } = await supabase
    .from(STEPS_TABLE)
    .update(updates)
    .eq('id', node.id)
    .select('*')
    .single();
  if (updateError) {
    console.warn('[BranchSteps] write-through update failed:', updateError.message);
    return;
  }

  // Re-mirror so the flat row stays the canonical projection of the node.
  await syncBranchStepForNode(sequenceId, updatedNode);
}

/** Remove flat branch-step rows for a set of sequence_steps nodes. */
async function removeBranchStepsForNodes(sequenceId, nodes) {
  for (const node of nodes || []) {
    if (!node || node.step_number == null || !node.parent_branch) continue;
    const { error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .delete()
      .eq('sequence_id', sequenceId)
      .eq('step', Number(node.step_number))
      .eq('parent_branch', node.parent_branch);
    if (error) console.warn('[BranchSteps] delete failed:', error.message);
  }
}

/** Fetch one branch-step row that belongs to a sequence (404 when missing). */
async function branchStepBelongsToSequence(sequenceId, branchStepId) {
  const { data, error } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .select('*')
    .eq('id', branchStepId)
    .eq('sequence_id', sequenceId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch branch step');
  if (!data) notFound('Branch step', branchStepId);
  return data;
}

/**
 * List the flat branch-step rows (sequence_branch_steps) for one sequence,
 * ordered by step so the UI can render the tree top-down.
 */
export async function listBranchSteps(sequenceId) {
  await sequenceExists(sequenceId);
  // Self-heal the mirror so the flat rows always match the canonical tree.
  await reconcileBranchSteps(sequenceId);
  // Keep the sequences.subject_N/body_N content columns in sync (best-effort).
  await syncSequenceContentColumns(sequenceId);
  const { data, error } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('step', { ascending: true })
    .order('parent_branch', { ascending: true });
  if (error) throw toError(error, 'Failed to list branch steps');
  return data || [];
}

/** Validate the editable fields of a branch-step row. */
function validateBranchStepData(data) {
  const updates = {};

  if (data && data.parent_step !== undefined) {
    if (data.parent_step === null || data.parent_step === '') {
      updates.parent_step = null;
    } else {
      const parentStep = Number(data.parent_step);
      if (!Number.isFinite(parentStep) || parentStep < 1 || !Number.isInteger(parentStep)) {
        badRequest('parent_step must be a positive integer or null');
      }
      updates.parent_step = parentStep;
    }
  }
  if (data && data.parent_branch !== undefined) {
    const branch = String(data.parent_branch).trim().toUpperCase();
    if (![BRANCH_STARTING, BRANCH_OPENED, BRANCH_NOT_OPENED].includes(branch)) {
      badRequest('parent_branch must be STARTING, OPENED, or NOT_OPENED');
    }
    updates.parent_branch = branch;
  }
  if (data && data.wait_hours !== undefined) {
    const waitHours = Number(data.wait_hours);
    if (!Number.isFinite(waitHours) || waitHours < 0 || !Number.isInteger(waitHours)) {
      badRequest('wait_hours must be an integer >= 0');
    }
    updates.wait_hours = waitHours;
  }
  if (data && data.subject !== undefined) {
    const subject = String(data.subject).trim();
    if (!subject) badRequest('subject cannot be empty');
    updates.subject = subject;
  }
  if (data && data.body !== undefined) {
    const body = String(data.body).trim();
    if (!body) badRequest('body cannot be empty');
    updates.body = body;
  }
  if (data && data.template_id !== undefined) {
    updates.template_id = data.template_id ? String(data.template_id).trim() : null;
  }
  return updates;
}

/**
 * Update a branch-step row's editable fields (parent_step, parent_branch,
 * wait_hours, subject, body). Only rows belonging to the given sequence are touched.
 */
export async function updateBranchStep(sequenceId, branchStepId, data) {
  const existing = await branchStepBelongsToSequence(sequenceId, branchStepId);
  const updates = validateBranchStepData({
    parent_step:
      data && data.parent_step !== undefined ? data.parent_step : existing.parent_step,
    parent_branch:
      data && data.parent_branch !== undefined ? data.parent_branch : existing.parent_branch,
    wait_hours: data && data.wait_hours !== undefined ? data.wait_hours : existing.wait_hours,
    subject: data && data.subject !== undefined ? data.subject : existing.subject,
    body: data && data.body !== undefined ? data.body : existing.body,
    template_id:
      data && data.template_id !== undefined ? data.template_id : existing.template_id,
  });
  updates.updated_at = new Date().toISOString();

  // Omit template_id until the migration adding the column runs.
  if (!(await hasTableColumn(BRANCH_STEPS_TABLE, 'template_id'))) {
    delete updates.template_id;
  }

  const { data: updated, error } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .update(updates)
    .eq('id', branchStepId)
    .eq('sequence_id', sequenceId)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to update branch step');

  // Write the edit through to the canonical sequence_steps node so the worker
  // (which reads sequence_steps) and the Sequence page reflect the change.
  await syncSequenceStepFromBranchStep(sequenceId, existing, updated);

  // Keep the sequences.subject_N/body_N content columns in sync (best-effort).
  await syncSequenceContentColumns(sequenceId);

  return updated;
}

/** Delete a branch-step row (scoped to its sequence). */
export async function deleteBranchStep(sequenceId, branchStepId) {
  await branchStepBelongsToSequence(sequenceId, branchStepId);
  const { error } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .delete()
    .eq('id', branchStepId)
    .eq('sequence_id', sequenceId);
  if (error) throw toError(error, 'Failed to delete branch step');
  return { deleted: true, id: branchStepId };
}

// ─── Shared helpers ────────────────────────────────────────────────────────

async function getSequenceRow(id) {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence');
  if (!data) notFound('Sequence', id);
  return data;
}

async function sequenceExists(id) {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence');
  if (!data) notFound('Sequence', id);
  return data;
}

async function stepBelongsToSequence(sequenceId, stepId) {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('id', stepId)
    .eq('sequence_id', sequenceId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch step');
  if (!data) notFound('Step', stepId);
  return data;
}

/**
 * Verify a parent step (referenced by its exact node id) exists in this
 * sequence. Used by createStep/updateStep for branch-tree parenting.
 */
async function assertParentStepExists(sequenceId, parentStepId) {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('id', parentStepId)
    .is('archived_at', null)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to validate parent step');
  if (!data) badRequest('Parent step does not exist in this sequence');
}

/**
 * Validate the audience/step requirements that must be satisfied before a
 * sequence may be activated (used by activate + status changes). There is no
 * Starting Campaign requirement — the sequence sends its own Step 1.
 */
async function assertActivatable(id) {
  const sequence = await getSequenceRow(id);

  const missing = [];
  if (!sequence.name || !String(sequence.name).trim()) missing.push('name');
  if (!sequence.audience_segment || !String(sequence.audience_segment).trim()) {
    missing.push('audience_segment');
  }

  const { data: steps, error: stepsError } = await supabase
    .from(STEPS_TABLE)
    .select('id')
    .eq('sequence_id', id)
    .is('archived_at', null)
    .limit(1);
  if (stepsError) throw toError(stepsError, 'Failed to check sequence steps');
  if (!steps || steps.length === 0) missing.push('at least one step');

  if (missing.length > 0) {
    badRequest(`Cannot activate — missing: ${missing.join(', ')}`);
  }
}

// ─── sequences.subject_N / body_N content columns ────────────────────────────
//
// The `sequences` row also carries per-step content columns (subject_1/body_1,
// subject_2/body_2, subject_2a/body_2a, … subject_12a/body_12a) — the Sequence
// Builder's save target for what the user configured. The canonical content
// lives in sequence_steps (normal_* for STARTING/OPENED nodes, increment_* for
// NOT_OPENED nodes); these helpers project that tree onto the flat columns so
// the `sequences` row can never drift from the builder:
//   STARTING / OPENED node at step_number N  -> subject_N  / body_N
//   NOT_OPENED node at step_number N         -> subject_Na / body_Na
// The projection runs after every step/branch mutation AND on read (self-heal),
// and createSequence/updateSequence also persist these keys directly when the
// client sends them, so the INSERT/UPDATE itself carries the fields.

const SEQUENCE_CONTENT_COLUMN = /^(subject|body)_(\d+)(a)?$/;

/** Keys of a save payload that map to the sequences content columns. */
function contentColumnKeys(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of Object.keys(data)) {
    if (!SEQUENCE_CONTENT_COLUMN.test(key)) continue;
    const n = Number(key.replace(/^(subject|body)_/, '').replace(/a$/, ''));
    if (!Number.isInteger(n) || n < 1 || n > 12) continue;
    const v = data[key];
    out[key] = v === null || v === undefined ? null : String(v).trim() || null;
  }
  return out;
}

/** Build the subject_N/body_N content-column payload from canonical steps. */
function contentColumnsFromSteps(steps) {
  const out = {};
  for (const node of steps || []) {
    if (!node || node.archived_at) continue;
    const n = Number(node.step_number);
    if (!Number.isInteger(n) || n < 1 || n > 12) continue;
    if (node.parent_branch === BRANCH_NOT_OPENED) {
      out[`subject_${n}a`] = node.increment_subject || null;
      out[`body_${n}a`] = node.increment_body || null;
    } else {
      out[`subject_${n}`] = node.normal_subject || null;
      out[`body_${n}`] = node.normal_body || null;
    }
  }
  return out;
}

/** Recompute the sequences content columns from the canonical step tree. */
async function syncSequenceContentColumns(sequenceId) {
  try {
    const { data: steps, error } = await supabase
      .from(STEPS_TABLE)
      .select('*')
      .eq('sequence_id', sequenceId)
      .is('archived_at', null);
    if (error) {
      console.warn(`[SequenceContent] load failed: ${error.message}`);
      return;
    }
    const columns = contentColumnsFromSteps(steps || []);
    const { error: upErr } = await supabase
      .from(SEQUENCES_TABLE)
      .update({ ...columns, updated_at: new Date().toISOString() })
      .eq('id', sequenceId);
    if (upErr) console.warn(`[SequenceContent] sync failed: ${upErr.message}`);
  } catch (err) {
    console.warn('[SequenceContent] sync failed:', err && err.message);
  }
}

// ─── Sequence CRUD ─────────────────────────────────────────────────────────

export async function listSequences() {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Failed to list sequences');

  const sequences = data || [];

  // Step counts.
  const ids = sequences.map((s) => s.id);
  const stepCounts = {};
  if (ids.length > 0) {
    const { data: steps, error: sError } = await supabase
      .from(STEPS_TABLE)
      .select('sequence_id')
      .is('archived_at', null);
    if (!sError) {
      for (const st of steps || []) {
        stepCounts[st.sequence_id] = (stepCounts[st.sequence_id] || 0) + 1;
      }
    }
  }

  return sequences.map((s) => ({
    ...s,
    steps_count: stepCounts[s.id] || 0,
  }));
}

export async function getSequence(id) {
  const sequence = await getSequenceRow(id);

  // Self-heal legacy step-log links (email_log_id backfill) BEFORE any
  // tracking count is read, so opened/clicked/engagement always come from the
  // real email_logs rows instead of never-synced step-log flags. Cached per
  // sequence inside the helper — a no-op once reconciled.
  await backfillStepLogEmailLinks(id);

  // Reconcile the step-log tracking flags from their linked email_logs so any
  // flagged read (Logs API, eligibility fallback) mirrors the authoritative
  // tracking record. Cached per sequence — a no-op once reconciled.
  await syncStepLogTrackingFromLinks(id);

  const { data: steps, error: stepsError } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('sequence_id', id)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (stepsError) throw toError(stepsError, 'Failed to fetch sequence steps');

  // Recipient engagement + overview (all values read from the database).
  const [engagement, audience, enrollments, stepLogs] =
    await Promise.all([
      sequenceEngagement(id),
      resolveSequenceAudience(sequence),
      supabase
        .from(ENROLLMENTS_TABLE)
        .select('status, contact_id, current_step, current_step_id, current_email_type')
        .eq('sequence_id', id),
      supabase
        .from(STEP_LOGS_TABLE)
        .select('sequence_step_id, contact_id, email_log_id, opened, clicked')
        .eq('sequence_id', id),
    ]);
  if (enrollments.error) throw toError(enrollments.error, 'Failed to load sequence enrollments');
  if (stepLogs.error) throw toError(stepLogs.error, 'Failed to load sequence step logs');

  const enrollmentRows = enrollments.data || [];
  const summary = {
    total_eligible: audience.length,
    total: enrollmentRows.length,
    in_progress: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  };
  for (const enrollment of enrollmentRows) {
    if (enrollment.status === 'completed') summary.completed += 1;
    else summary.in_progress += 1;
  }
  summary.pending = Math.max(0, summary.total_eligible - summary.total);

  const stepLogRows = stepLogs.data || [];

  // The linked email_logs carry the authoritative open/click tracking for the
  // node emails (sequence_step_logs.opened/clicked are only synced best-effort
  // by the worker), so they are read directly for the real per-node counts.
  const emailLogIds = [
    ...new Set(stepLogRows.map((log) => log.email_log_id).filter(Boolean)),
  ];
  const emailLogsById = new Map();
  if (emailLogIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('email_logs')
      .select('id, status, opened, opened_at, clicked, clicked_at')
      .in('id', emailLogIds);
    if (logsError) throw toError(logsError, 'Failed to load sequence email logs');
    for (const log of logs || []) emailLogsById.set(log.id, log);
  }

  const enrolledContactIds = [...new Set(enrollmentRows.map((e) => e.contact_id))];

  const stepsList = steps || [];

  // Reconcile the flat branch-step mirror against the canonical tree so the
  // Sequence page and the Edit Sequence modal read the SAME records, with the
  // real parent row id (parent_step_id) always set. Best-effort self-heal.
  await reconcileBranchSteps(id, stepsList);
  // Keep the sequences.subject_N/body_N content columns in sync (best-effort).
  await syncSequenceContentColumns(id);

  const steps_progress = [];
  const nextByNode = await buildNextEmails(id, stepsList);
  for (const node of stepsList) {
    const nodeLogs = stepLogRows.filter((log) => log.sequence_step_id === node.id);

    // Per-node branch eligibility — the same central logic the worker uses for
    // PENDING recipients, UNION the recipients already sent this exact node.
    //
    // Eligible must never be smaller than Sent. A recipient is on a node's
    // branch from the moment their parent email matches the branch; once they
    // have actually received THIS node's email that send history locks them into
    // the branch. Re-evaluating ONLY the current parent-tracking state would
    // drop recipients whose parent state changed AFTER the send (e.g. a
    // recipient sent a NOT_OPENED email who later opens the parent) and produce
    // the impossible Sent > Eligible table.
    //
    // Identity is EXACT: sequence_id + node id (sequence_step_id) + recipient
    // (contact_id / enrollment). Sibling nodes that merely share a step_number
    // are never mixed because every query filters by the precise node row.
    const eligMap = await getBranchEligibility(id, node.id, enrolledContactIds);
    const eligibleIds = new Set();
    for (const contactId of enrolledContactIds) {
      const row = eligMap.get(contactId);
      if (row && row.eligible) eligibleIds.add(contactId);
    }
    for (const log of nodeLogs) {
      if (log && log.contact_id) eligibleIds.add(log.contact_id);
    }
    const eligible = eligibleIds.size;

    const path = node.parent_branch || BRANCH_STARTING;
    const pathLabel =
      path === BRANCH_NOT_OPENED ? 'Not Opened' : path === BRANCH_OPENED ? 'Opened' : 'Starting';
    const parent = node.parent_step_id
      ? stepsList.find((s) => s.id === node.parent_step_id) || null
      : null;
    const parentLabel = parent
      ? `Step ${parent.step_number}${parent.parent_branch === BRANCH_NOT_OPENED ? 'A' : ''} — ${path === BRANCH_NOT_OPENED ? 'Not Opened' : 'Opened'}`
      : 'Starting Step';

    // Sent/Opened/Clicked count ONLY the emails that were successfully sent to
    // this EXACT node (step + branch) for this sequence. Each step log links to
    // the exact email_log tracking record, so an open/click that belongs to a
    // different step, branch, sequence or a different email for the same
    // recipient can never leak into this node's numbers.
    let sent = 0;
    let opened = 0;
    let clicked = 0;
    for (const log of nodeLogs) {
      const emailLog = log.email_log_id ? emailLogsById.get(log.email_log_id) : null;
      const sentOk = emailLog ? emailLog.status === 'sent' : log.status === 'sent';
      if (!sentOk) continue;
      sent += 1;
      if (emailLog ? emailLog.opened === true : log.opened === true) opened += 1;
      if (emailLog ? emailLog.clicked === true : log.clicked === true) clicked += 1;
    }

    // Hard invariants: Sent <= Eligible, Opened <= Sent, Clicked <= Sent.
    // sentContactIds ⊂ eligibleIds by construction above; opened/clicked only
    // ever come from emails that were sent, so both stay within Sent.
    const waitHours = waitHoursOf(node);
    let status = 'not_started';
    if (sent > 0 && eligible > 0 && sent >= eligible) status = 'completed';
    else if (sent > 0) status = 'in_progress';
    else if (eligible > 0 && waitHours > 0) status = 'in_progress'; // waiting on wait_hours

    // The next branch emails for this node (its children) — resolved from the
    // actual child rows (best-effort mirrored in sequence_branch_steps) keyed by
    // sequence_id + parent_step_id + parent_branch, never by step_number alone.
    const next = nextByNode.get(node.id) || [];

    steps_progress.push({
      step: node,
      subject: nodeContentSubject(node),
      path,
      path_label: pathLabel,
      parent_label: parentLabel,
      wait_hours: waitHours,
      wait_label: waitHours === 0 ? 'Immediate' : `${waitHours}h`,
      eligible,
      sent,
      opened,
      clicked,
      status,
      next,
    });
  }

  return {
    ...sequence,
    engagement,
    summary,
    steps_progress,
    steps: stepsList,
  };
}

function childrenOf(steps, stepId) {
  return (steps || []).filter((s) => s.parent_step_id === stepId);
}

/**
 * Resolve the child rows (the "Next Emails") of every step node of one
 * sequence, keyed by the exact parent node id.
 *
 * Child identity is the real database relationship — sequence_id +
 * parent_step_id + parent_branch — never a step_number (siblings share step
 * numbers, so a number alone is ambiguous). The authoritative child set comes
 * from `sequence_steps`; subjects/labels are enriched from the best-effort
 * `sequence_branch_steps` mirror when that mirror row resolves unambiguously
 * (same sequence, child step + branch, and the mirror's parent_step matches the
 * parent's step_number).
 *
 * @param {string} sequenceId
 * @param {Array<object>} steps - active sequence_steps rows for the sequence.
 * @returns {Promise<Map<string, Array<object>>>} node id -> next emails
 */
async function buildNextEmails(sequenceId, steps) {
  const nextByNode = new Map();
  const nodesWithChildren = (steps || []).filter((s) =>
    (steps || []).some((c) => c.parent_step_id === s.id)
  );
  if (nodesWithChildren.length === 0) return nextByNode;

  let branchSteps = [];
  try {
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('sequence_id, step, parent_step, parent_branch, subject')
      .eq('sequence_id', sequenceId);
    if (!error) branchSteps = data || [];
  } catch (error) {
    console.warn(`[sequenceService] Failed to load branch steps for next emails: ${error && error.message}`);
  }

  for (const node of nodesWithChildren) {
    const children = childrenOf(steps, node.id).map((child) => {
      const candidates = branchSteps.filter(
        (b) =>
          b.sequence_id === sequenceId &&
          Number(b.step) === Number(child.step_number) &&
          b.parent_branch === child.parent_branch &&
          Number(b.parent_step) === Number(node.step_number)
      );
      const flatRow = candidates.length === 1 ? candidates[0] : null;
      return {
        step_number: Number(child.step_number),
        branch: child.parent_branch === BRANCH_NOT_OPENED ? BRANCH_NOT_OPENED : BRANCH_OPENED,
        label: child.parent_branch === BRANCH_NOT_OPENED ? 'Not Opened' : 'Opened',
        subject: flatRow && flatRow.subject ? flatRow.subject : nodeContentSubject(child),
      };
    });
    nextByNode.set(node.id, children);
  }
  return nextByNode;
}

function nodeContentSubject(node) {
  if (node && node.parent_branch === BRANCH_NOT_OPENED) {
    return node.increment_subject || node.normal_subject || null;
  }
  return node ? node.normal_subject || null : null;
}

export async function createSequence(data) {
  const name = requireString(data && data.name, 'name');
  const audienceSegment = requireString(data && data.audience_segment, 'audience_segment');

  const triggerType = data && data.trigger_type
    ? String(data.trigger_type).trim()
    : 'behaviour';
  if (!TRIGGER_TYPES.includes(triggerType)) {
    badRequest(`trigger_type must be one of: ${TRIGGER_TYPES.join(', ')}`);
  }

  // Recipient filtering + send mode. Defaults: every eligible recipient,
  // automatic + manual sending.
  const recipientType = enumValue(data && data.recipient_type, 'recipient_type', RECIPIENT_TYPES) || 'all';
  const sendMode = enumValue(data && data.send_mode, 'send_mode', SEND_MODES) || 'both';

  // Sequences always start as drafts; activation goes through the activate
  // endpoint (which enforces "at least one step").
  const { data: created, error } = await supabase
    .from(SEQUENCES_TABLE)
    .insert({
      name,
      audience_segment: audienceSegment,
      trigger_type: triggerType,
      recipient_type: recipientType,
      send_mode: sendMode,
      status: 'draft',
      ...contentColumnKeys(data),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to create sequence');
  return created;
}

export async function updateSequence(id, data) {
  await getSequenceRow(id);

  const updates = { updated_at: new Date().toISOString() };

  if (data && data.name !== undefined) {
    updates.name = requireString(data.name, 'name');
  }
  if (data && data.audience_segment !== undefined) {
    updates.audience_segment = requireString(data.audience_segment, 'audience_segment');
  }
  if (data && data.trigger_type !== undefined) {
    const triggerType = String(data.trigger_type).trim();
    if (!TRIGGER_TYPES.includes(triggerType)) {
      badRequest(`trigger_type must be one of: ${TRIGGER_TYPES.join(', ')}`);
    }
    updates.trigger_type = triggerType;
  }
  if (data && data.recipient_type !== undefined) {
    updates.recipient_type = enumValue(data.recipient_type, 'recipient_type', RECIPIENT_TYPES);
  }
  if (data && data.send_mode !== undefined) {
    updates.send_mode = enumValue(data.send_mode, 'send_mode', SEND_MODES);
  }

  // Persist the Sequence Builder's per-step content columns when the client
  // sends them (subject_1/body_1 … subject_12a/body_12a) — see the
  // subject_N / body_N section above. Best-effort sanity on values.
  Object.assign(updates, contentColumnKeys(data));

  const { data: updated, error } = await supabase
    .from(SEQUENCES_TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to update sequence');
  return updated;
}

export async function deleteSequence(id) {
  const sequence = await getSequenceRow(id);
  // Clean the flat branch-step mirror first — it has no FK to sequences (only a
  // self-referencing parent_step_id), so its rows would be orphaned when the
  // sequence row is deleted.
  const { error: branchError } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .delete()
    .eq('sequence_id', id);
  if (branchError) {
    console.warn(`[sequenceService] Failed to clean branch steps for sequence ${id}: ${branchError.message}`);
  }
  // Clean up the sequence's dedicated hidden campaign (and its email_logs,
  // contacts, analytics) when it exists. Best-effort — a sequence that never
  // sent has no dedicated campaign.
  if (sequence.campaign_id) {
    try {
      await deleteCampaign(sequence.campaign_id);
    } catch (e) {
      console.warn(`[sequenceService] Failed to delete sequence campaign ${sequence.campaign_id}: ${e.message}`);
    }
  }
  const { error } = await supabase.from(SEQUENCES_TABLE).delete().eq('id', id);
  if (error) throw toError(error, 'Failed to delete sequence');
  return true;
}

// ─── Selector data (from the database) ─────────────────────────────────────

/**
 * Audience/segment options for the target-audience selector.
 *
 * Derived entirely from existing database data:
 *   - every distinct `contacts.contact_type`
 *   - every distinct `contacts.company_category`
 *   - every distinct `campaigns.audience_segment` already in use
 * plus the universal "All Contacts" option.
 */
export async function listAudienceOptions() {
  const audiences = new Map();
  const add = (value) => {
    const v = String(value || '').trim();
    if (v && !audiences.has(v)) audiences.set(v, { id: v, label: v });
  };

  add('All Contacts');

  const { data: contactTypes, error: e1 } = await supabase
    .from('contacts')
    .select('contact_type');
  if (!e1) for (const row of contactTypes || []) add(row.contact_type);

  const { data: categories, error: e2 } = await supabase
    .from('contacts')
    .select('company_category');
  if (!e2) for (const row of categories || []) add(row.company_category);

  const { data: segments, error: e3 } = await supabase
    .from('campaigns')
    .select('audience_segment');
  if (!e3) for (const row of segments || []) add(row.audience_segment);

  const { data: contactTypeRows, error: e4 } = await supabase
    .from('contact_types')
    .select('name')
    .eq('is_active', true);
  if (!e4) for (const row of contactTypeRows || []) add(row.name);

  return [...audiences.values()];
}

// ─── Recipient resolution ─────────────────────────────────────────────────

/**
 * Engagement breakdown from the sequence's OWN sent step emails: distinct
 * contacts who received any step email (all), how many of those opened any of
 * them (opened) and how many did not (not_opened). Drives the "Recipient
 * Engagement" summary cards.
 */
async function sequenceEngagement(sequenceId) {
  const { data: logs, error } = await supabase
    .from(STEP_LOGS_TABLE)
    .select('contact_id, email_log_id')
    .eq('sequence_id', sequenceId);
  if (error) throw toError(error, 'Failed to load sequence engagement');

  const emailLogIds = [
    ...new Set((logs || []).map((l) => l.email_log_id).filter(Boolean)),
  ];
  const openedByLogId = new Map();
  if (emailLogIds.length > 0) {
    const { data: emailLogs, error: e2 } = await supabase
      .from('email_logs')
      .select('id, opened')
      .in('id', emailLogIds);
    if (e2) throw toError(e2, 'Failed to load sequence email engagement');
    for (const log of emailLogs || []) openedByLogId.set(log.id, log.opened === true);
  }

  const received = new Set();
  const openedContacts = new Set();
  for (const log of logs || []) {
    if (!log.contact_id) continue;
    received.add(log.contact_id);
    if (openedByLogId.get(log.email_log_id)) openedContacts.add(log.contact_id);
  }
  return {
    all: received.size,
    opened: openedContacts.size,
    not_opened: Math.max(0, received.size - openedContacts.size),
  };
}

/**
 * The sequence's full eligible audience: deliverable, deduplicated contacts for
 * the target audience. This is the base set activation enrolls — per-node
 * branch narrowing happens against enrollments (see getBranchEligibility).
 */
async function resolveSequenceAudience(sequence) {
  const contacts = await resolveContactsForAudience(sequence.audience_segment);
  return dedupeContacts(contacts || []);
}

function dedupeContacts(contacts) {
  const seenEmails = new Set();
  const out = [];
  for (const contact of contacts || []) {
    if (!isDeliverableRecipientEmail(contact.email)) continue;
    const key = normalizeEmail(contact.email);
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    out.push(contact);
  }
  return out;
}

async function listSteps(sequenceId) {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('sequence_id', sequenceId)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (error) throw toError(error, 'Failed to fetch sequence steps');
  return data || [];
}

/**
 * Enrolled contacts (enrollments joined with the contact row), ordered newest
 * first. The base set used by the recipients UI + manual send.
 */
async function getEnrolledContacts(sequenceId) {
  const { data, error } = await supabase
    .from(ENROLLMENTS_TABLE)
    .select('*, contacts(*)')
    .eq('sequence_id', sequenceId)
    .order('enrolled_at', { ascending: false });
  if (error) throw toError(error, 'Failed to fetch sequence enrollments');
  return data || [];
}

/**
 * Canonical per-node recipient resolver — the single source of truth used by
 * the recipients UI, manual send and (via getBranchEligibility) the Step
 * Progress table and the worker.
 *
 * Resolves the sequence's enrolled contacts, evaluates each recipient's branch
 * membership against the node's PARENT email tracking (opened / not opened;
 * the starting node includes everyone), and keeps only branch-eligible
 * recipients. Engagement always comes from actual tracking data.
 */
export async function resolveSequenceRecipients(sequenceId, stepId) {
  const sequence = await getSequenceRow(sequenceId);
  const steps = await listSteps(sequenceId);
  const step = stepId ? steps.find((s) => s.id === stepId) : startingNodeOf(steps);
  if (stepId && !step) notFound('Step', stepId);

  const enrolled = await getEnrolledContacts(sequenceId);
  const contactIds = enrolled.map((e) => e.contact_id);
  const eligMap = await getBranchEligibility(sequenceId, step.id, contactIds);

  return {
    sequence,
    step,
    recipients: enrolled.filter((e) => {
      const row = eligMap.get(e.contact_id);
      return row && row.eligible;
    }),
    eligibility: eligMap,
  };
}

// ─── Steps ─────────────────────────────────────────────────────────────────

function validateStepData(data) {
  const optional = (value) =>
    value !== undefined && value !== null && String(value).trim()
      ? String(value).trim()
      : null;

  // A node carries either NORMAL ("Opened") content, INCREMENT ("Not Opened")
  // content, or both. Branch nodes may hold only one variant, so at least one
  // subject is required and the other is stored as '' (the columns are NOT NULL).
  // A step whose Send Action is "Skip This Step" is never emailed, so its
  // subject/body may stay empty.
  const sendAction =
    enumValue(data && data.send_action, 'send_action', SEND_ACTIONS) || 'send_automatically';

  const normalSubject = optional(data && data.normal_subject) || '';
  const normalBody = optional(data && data.normal_body) || '';
  const incrementSubject = optional(data && data.increment_subject);
  const incrementBody = optional(data && data.increment_body);
  if (!normalSubject && !incrementSubject && sendAction !== 'skip') {
    badRequest('normal_subject or increment_subject is required (unless this step is skipped)');
  }

  const waitHours = Number(data && data.wait_hours);
  if (!Number.isInteger(waitHours) || waitHours < 0) {
    badRequest('wait_hours must be an integer >= 0');
  }

  // "Send After" delay — value + unit (minutes | hours | days). Null when no
  // delay is configured (the worker then falls back to wait_hours).
  let sendAfterValue = null;
  if (
    data &&
    data.send_after_value !== undefined &&
    data.send_after_value !== null &&
    data.send_after_value !== ''
  ) {
    const raw = Number(data.send_after_value);
    if (!Number.isFinite(raw) || raw < 0) {
      badRequest('send_after_value must be a number >= 0');
    }
    sendAfterValue = Math.floor(raw);
  }
  let sendAfterUnit =
    (data && data.send_after_unit !== undefined && data.send_after_unit !== null
      ? enumValue(data.send_after_unit, 'send_after_unit', SEND_AFTER_UNITS)
      : null) || null;
  if (sendAfterValue != null && sendAfterValue > 0 && !sendAfterUnit) {
    sendAfterUnit = null;
  }

  // Per-node recipient filter (legacy affordance): who is allowed to receive
  // THIS node. Default 'all' — the real gating is the parent branch.
  const recipientType =
    enumValue(data && data.recipient_type, 'recipient_type', RECIPIENT_TYPES) || 'all';

  // Branch-tree parenting. The node references its EXACT parent node id
  // (parent_step_id) + which path of it this node is (parent_branch). Legacy
  // parent_path (a step NUMBER) / branch_type are still accepted and converted
  // by the caller when possible. The starting step has no parent and stores
  // parent_branch = 'STARTING' (the column is NOT NULL).
  let parentStepId = data && data.parent_step_id !== undefined && data.parent_step_id !== null
    ? String(data.parent_step_id).trim()
    : null;
  let branch = normalizeBranch(data && data.parent_branch);
  if (!parentStepId && data && data.parent_path !== undefined && data.parent_path !== null) {
    parentStepId = String(data.parent_path).trim();
  }
  if (!branch && data && data.branch_type !== undefined && data.branch_type !== null) {
    branch = normalizeBranch(data.branch_type);
  }

  if (parentStepId) {
    // A child node must declare which path of its parent it is.
    if (branch !== BRANCH_OPENED && branch !== BRANCH_NOT_OPENED) {
      badRequest('parent_branch must be OPENED or NOT_OPENED when parent_step_id is set');
    }
  } else if (branch && branch !== BRANCH_STARTING) {
    // A parentless node may only be the root; anything else is a dangling ref.
    badRequest('parent_step_id is required when parent_branch is set');
  }

  const parentFields = {
    parent_step_id: parentStepId,
    parent_branch: parentStepId ? branch : BRANCH_STARTING,
  };

  return {
    normal_subject: normalSubject,
    normal_body: normalBody,
    increment_subject: incrementSubject,
    increment_body: incrementBody,
    normal_template_id: optional(data && data.normal_template_id),
    increment_template_id: optional(data && data.increment_template_id),
    from_name: optional(data && data.from_name),
    wait_hours: waitHours,
    recipient_type: recipientType,
    ...parentFields,
  };
}

export async function createStep(sequenceId, data) {
  await sequenceExists(sequenceId);
  const step = validateStepData(data);

  // Omit template-reference columns until the migration adding them runs.
  if (!(await hasTableColumn(STEPS_TABLE, 'normal_template_id'))) {
    delete step.normal_template_id;
    delete step.increment_template_id;
  }

  // A parent node must already exist in THIS sequence, and a node can never be
  // its own parent (branching never crosses sequence boundaries).
  if (step.parent_step_id) {
    await assertParentStepExists(sequenceId, step.parent_step_id);
  }

  let stepNumber = data && data.step_number;
  if (stepNumber === undefined || stepNumber === null) {
    const { data: maxRow } = await supabase
      .from(STEPS_TABLE)
      .select('step_number')
      .eq('sequence_id', sequenceId)
      .is('archived_at', null)
      .order('step_number', { ascending: false })
      .limit(1);
    stepNumber = (maxRow && maxRow[0] ? Number(maxRow[0].step_number) : 0) + 1;
  } else {
    stepNumber = Number(stepNumber);
    if (!Number.isInteger(stepNumber) || stepNumber < 1) {
      badRequest('step_number must be an integer >= 1');
    }
  }

  const { data: created, error } = await supabase
    .from(STEPS_TABLE)
    .insert({
      sequence_id: sequenceId,
      step_number: stepNumber,
      ...step,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      badRequest('A step already exists for this parent step + branch in this sequence');
    }
    throw toError(error, 'Failed to create step');
  }

  // Adding a child to an ACTIVE sequence is the exact moment a branch that
  // completed while this step was a leaf must resume (and wait-0 children send
  // right away). Fire-and-forget — scoped to this sequence, guarded by the
  // worker's `_checking` flag + atomic enrollment claim.
  const { data: seqRow } = await supabase
    .from(SEQUENCES_TABLE)
    .select('status')
    .eq('id', sequenceId)
    .maybeSingle();
  if (seqRow && seqRow.status === 'active') {
    void checkDueEnrollments([sequenceId]);
  }

  // Mirror the new node into the flat sequence_branch_steps table (best-effort).
  await syncBranchStepForNode(sequenceId, created);

  // Keep the sequences.subject_N/body_N content columns in sync (best-effort).
  await syncSequenceContentColumns(sequenceId);

  return created;
}

export async function updateStep(sequenceId, stepId, data) {
  const existing = await stepBelongsToSequence(sequenceId, stepId);

  const validated = validateStepData({
    normal_subject: data && data.normal_subject !== undefined ? data.normal_subject : existing.normal_subject,
    normal_body: data && data.normal_body !== undefined ? data.normal_body : existing.normal_body,
    increment_subject: data && data.increment_subject !== undefined ? data.increment_subject : existing.increment_subject,
    increment_body: data && data.increment_body !== undefined ? data.increment_body : existing.increment_body,
    normal_template_id: data && data.normal_template_id !== undefined ? data.normal_template_id : existing.normal_template_id,
    increment_template_id: data && data.increment_template_id !== undefined ? data.increment_template_id : existing.increment_template_id,
    from_name: data && data.from_name !== undefined ? data.from_name : existing.from_name,
    wait_hours: data && data.wait_hours !== undefined ? data.wait_hours : existing.wait_hours,
    recipient_type: data && data.recipient_type !== undefined ? data.recipient_type : existing.recipient_type,
    parent_step_id: data && data.parent_step_id !== undefined ? data.parent_step_id : existing.parent_step_id,
    parent_branch: data && data.parent_branch !== undefined ? data.parent_branch : existing.parent_branch,
    parent_path: data && data.parent_path !== undefined ? data.parent_path : existing.parent_path,
    branch_type: data && data.branch_type !== undefined ? data.branch_type : existing.branch_type,
  });

  // Branch sanity: a node can never be its own parent, and any parent must
  // belong to this same sequence.
  if (validated.parent_step_id) {
    if (String(validated.parent_step_id) === String(existing.id)) {
      badRequest('A step cannot be its own parent');
    }
    await assertParentStepExists(sequenceId, validated.parent_step_id);
  }

  const updates = { ...validated, updated_at: new Date().toISOString() };

  // Omit template-reference columns until the migration adding them runs.
  if (!(await hasTableColumn(STEPS_TABLE, 'normal_template_id'))) {
    delete updates.normal_template_id;
    delete updates.increment_template_id;
  }

  // Explicitly clearing the parent (client chose "Starting Step / linear").
  // validateStepData omits parent keys when unset, so clear them here only when
  // the request explicitly asked to remove an EXISTING parent. The root keeps
  // parent_branch = 'STARTING' (NOT NULL) instead of null.
  const wantsNoParent =
    data && data.parent_step_id !== undefined &&
    (data.parent_step_id === null || String(data.parent_step_id).trim() === '') &&
    Boolean(existing.parent_step_id);
  if (wantsNoParent) {
    updates.parent_step_id = null;
    updates.parent_branch = BRANCH_STARTING;
  }

  if (data && data.step_number !== undefined) {
    const stepNumber = Number(data.step_number);
    if (!Number.isInteger(stepNumber) || stepNumber < 1) {
      badRequest('step_number must be an integer >= 1');
    }
    updates.step_number = stepNumber;
  }

  const { data: updated, error } = await supabase
    .from(STEPS_TABLE)
    .update(updates)
    .eq('id', stepId)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      badRequest('A step already exists for this parent step + branch in this sequence');
    }
    throw toError(error, 'Failed to update step');
  }

  // Mirror the updated node into sequence_branch_steps: drop the row for the
  // previous (step_number, parent_branch) key when the key moved, then upsert.
  const oldKey = `${Number(existing.step_number)}|${existing.parent_branch}`;
  const newKey = `${Number(updated.step_number)}|${updated.parent_branch}`;
  if (oldKey !== newKey) {
    await removeBranchStepsForNodes([existing]);
  }
  await syncBranchStepForNode(sequenceId, updated);

  // Keep the sequences.subject_N/body_N content columns in sync (best-effort).
  await syncSequenceContentColumns(sequenceId);

  return updated;
}

function collectSubtreeIds(steps, rootId) {
  const ids = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (ids.includes(id)) continue;
    ids.push(id);
    for (const child of childrenOf(steps, id)) queue.push(child.id);
  }
  return ids;
}

/**
 * Delete a step node safely.
 *
 * Branch-tree rules:
 *   - The STARTING node (parent_step_id IS NULL) can only be deleted when it is
 *     the sequence's ONLY step AND the sequence is still a draft — otherwise the
 *     tree loses its root.
 *   - A node with child branches is NEVER deleted implicitly: the caller must
 *     confirm with `{ cascade: true }`, which removes/archives the entire
 *     subtree. Without it the service returns a 409 whose message lists the
 *     affected children so the UI can show them before asking for confirmation.
 *   - Branches are never re-parented on delete, so the OPENED / NOT_OPENED
 *     identities of a parent's children can never be swapped.
 *   - Historical data is preserved: if the affected subtree has ANY send
 *     history (sequence_step_logs) the rows are SOFT-deleted (archived_at set)
 *     so step logs + email tracking joins stay intact. Completely unused steps
 *     are hard-deleted. Archived steps are excluded by every tree reader.
 *   - Enrollments currently sitting on a node being removed are completed (their
 *     step history is untouched) instead of being left with a dangling
 *     current_step_id.
 *
 * @param {string} sequenceId
 * @param {string} stepId
 * @param {{ cascade?: boolean }} [options]
 */
export async function deleteStep(sequenceId, stepId, options = {}) {
  const step = await stepBelongsToSequence(sequenceId, stepId);
  if (step.archived_at) {
    return { deleted: false, already_deleted: true, step };
  }

  const sequence = await getSequenceRow(sequenceId);
  const steps = await listSteps(sequenceId);
  const isStarting = step.parent_step_id === null;

  if (isStarting) {
    if (steps.length > 1) {
      conflict(
        `The starting step cannot be deleted while ${steps.length - 1} other step(s) exist — delete or re-parent them first.`
      );
    }
    if (sequence.status !== 'draft') {
      conflict(`The starting step of a ${sequence.status} sequence cannot be deleted.`);
    }
  }

  const affectedIds = collectSubtreeIds(steps, stepId);
  const directChildren = childrenOf(steps, stepId);

  if (affectedIds.length > 1 && options.cascade !== true) {
    const children = directChildren.map((c) => ({
      id: c.id,
      step_number: Number(c.step_number),
      parent_branch: c.parent_branch,
      subject: nodeContentSubject(c) || c.normal_subject || 'Untitled step',
    }));
    const error = new Error(
      `This step has ${affectedIds.length - 1} child step(s) (and their descendants) that would be deleted. Confirm the deletion to remove them too.`
    );
    error.status = 409;
    error.detail = { children, affected_count: affectedIds.length };
    throw error;
  }

  // Mirror the removal into sequence_branch_steps (best-effort), BEFORE the
  // rows are archived/deleted so the flat table stops showing deleted steps.
  const { data: affectedNodes, error: affectedNodesError } = await supabase
    .from(STEPS_TABLE)
    .select('step_number, parent_branch')
    .in('id', affectedIds);
  if (!affectedNodesError) await removeBranchStepsForNodes(affectedNodes);

  // Complete any enrollment currently sitting on a node being removed BEFORE
  // the rows disappear — ON DELETE SET NULL would otherwise leave the
  // enrollment active with no current step.
  if (affectedIds.length > 0) {
    const nowIso = new Date().toISOString();
    const { error: enrollError } = await supabase
      .from(ENROLLMENTS_TABLE)
      .update({ status: 'completed', next_run_at: null, updated_at: nowIso })
      .in('current_step_id', affectedIds)
      .eq('status', 'active');
    if (enrollError) throw toError(enrollError, 'Failed to update enrollments on removed step');
  }

  // Preserve history: if any affected node has sent emails, soft-delete the
  // whole subtree so step logs + email tracking joins stay intact.
  const { data: logRows, error: logErr } = await supabase
    .from(STEP_LOGS_TABLE)
    .select('id')
    .in('sequence_step_id', affectedIds)
    .limit(1);
  if (logErr) throw toError(logErr, 'Failed to check step send history');
  const hasHistory = (logRows || []).length > 0;

  if (hasHistory) {
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from(STEPS_TABLE)
      .update({ archived_at: nowIso, updated_at: nowIso })
      .in('id', affectedIds);
    if (error) throw toError(error, 'Failed to archive step');
    await syncSequenceContentColumns(sequenceId);
    return {
      deleted: true,
      mode: 'archived',
      affected: affectedIds.length,
      archived_ids: affectedIds,
    };
  }

  const { error } = await supabase.from(STEPS_TABLE).delete().in('id', affectedIds);
  if (error) throw toError(error, 'Failed to delete step');
  await syncSequenceContentColumns(sequenceId);
  return {
    deleted: true,
    mode: 'deleted',
    affected: affectedIds.length,
    deleted_ids: affectedIds,
  };
}

// ─── Activate / Pause ──────────────────────────────────────────────────────

/**
 * Activate a sequence and enroll its target audience.
 *
 * Enrollment is idempotent: `UNIQUE (sequence_id, contact_id)` on
 * `sequence_enrollments` guarantees a contact is never enrolled twice.
 * Re-activating a sequence only backfills enrollments for contacts that are
 * not already enrolled, and triggers an immediate worker tick so the STARTING
 * step (Step 1) email goes out right away instead of waiting for the next 60s
 * interval.
 */
export async function activateSequence(id) {
  await assertActivatable(id);

  // 1. Load the sequence.
  const sequence = await getSequenceRow(id);

  // 2. Resolve the FULL eligible audience. Recipient narrowing is per-node
  //    (parent branch) and enforced at SEND time by the worker/manual sender.
  const contacts = await resolveSequenceAudience(sequence);

  // 3. The STARTING node (parent_step_id IS NULL) receives Step 1 first.
  const steps = await listSteps(id);
  const startingStep = startingNodeOf(steps);
  if (!startingStep) badRequest('Cannot activate — no starting step defined');

  const now = new Date().toISOString();

  // The STARTING node's saved wait_hours is its initial delay (no parent event
  // to measure from) — apply it at enrollment so the root waits too.
  const startingDue = new Date(Date.now() + waitHoursOf(startingStep) * 3600 * 1000).toISOString();

  // 4. One enrollment row per contact, all on the starting node, due after the
  //    starting step's wait_hours.
  const enrollments = (contacts || []).map((contact) => ({
    sequence_id: id,
    contact_id: contact.id,
    current_step_id: startingStep.id,
    current_step: Number(startingStep.step_number),
    current_email_type: 'normal',
    status: 'active',
    enrolled_at: now,
    next_run_at: startingDue,
  }));

  if (enrollments.length > 0) {
    // Upsert with ON CONFLICT DO NOTHING — never enroll the same contact twice.
    const { error: enrollError } = await supabase
      .from(ENROLLMENTS_TABLE)
      .upsert(enrollments, { onConflict: 'sequence_id,contact_id', ignoreDuplicates: true });
    if (enrollError) throw toError(enrollError, 'Failed to enroll contacts');
  }

  // 5. Make every already-enrolled contact's STARTING evaluation due after the
  //    starting wait (existing rows created by older versions may be scheduled
  //    far ahead). Enrollments already past the starting node keep their own
  //    schedules.
  const { error: resetError } = await supabase
    .from(ENROLLMENTS_TABLE)
    .update({ next_run_at: startingDue, updated_at: now })
    .eq('sequence_id', id)
    .eq('status', 'active')
    .eq('current_step_id', startingStep.id);
  if (resetError) throw toError(resetError, 'Failed to schedule sequence enrollments');

  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to activate sequence');

  // 6. Evaluate the freshly-enrolled audience IMMEDIATELY (fire-and-forget) so
  //    Step 1 is sent right now. Scoped to THIS sequence so the wake-up never
  //    drags other active sequences into the same tick. Guarded by the worker's
  //    `_checking` flag and the atomic enrollment claim, so concurrent ticks can
  //    never double-send.
  void checkDueEnrollments([id]);

  return {
    ...data,
    enrolled_count: enrollments.length,
    resolved_contacts: (contacts || []).length,
  };
}

export async function pauseSequence(id) {
  await sequenceExists(id);
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to pause sequence');
  return data;
}

// ─── Contacts + logs ───────────────────────────────────────────────────────

export async function listSequenceContacts(sequenceId) {
  await sequenceExists(sequenceId);
  const { data, error } = await supabase
    .from(ENROLLMENTS_TABLE)
    .select('*, contacts(id, full_name, email, company, contact_type, company_category)')
    .eq('sequence_id', sequenceId)
    .order('enrolled_at', { ascending: false });
  if (error) throw toError(error, 'Failed to fetch sequence contacts');

  return (data || []).map((row) => {
    const contact = row.contacts;
    return {
      id: row.id,
      sequence_id: row.sequence_id,
      contact_id: row.contact_id,
      current_step: row.current_step,
      current_step_id: row.current_step_id,
      current_email_type: row.current_email_type,
      current_email_log_id: row.current_email_log_id,
      status: row.status,
      next_run_at: row.next_run_at,
      sent_at: row.sent_at,
      enrolled_at: row.enrolled_at,
      last_action_at: row.last_action_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      contact,
    };
  });
}

export async function listSequenceLogs(sequenceId) {
  await sequenceExists(sequenceId);
  const { data, error } = await supabase
    .from(STEP_LOGS_TABLE)
    .select(
      '*, sequence_steps(step_number, normal_subject, normal_body), ' +
      'contacts(id, full_name, email)'
    )
    .eq('sequence_id', sequenceId)
    .order('sent_at', { ascending: false });
  if (error) throw toError(error, 'Failed to fetch sequence logs');

  // The authoritative open/click record lives on the linked email_log (that is
  // what the tracking pixel/links actually update). Merge it in so the Logs
  // table reflects real opens/clicks even when the step-log's own flags were
  // never synced (legacy rows / edge-mode opens).
  const rows = data || [];
  const emailLogIds = [...new Set(rows.map((r) => r.email_log_id).filter(Boolean))];
  const emailLogsById = new Map();
  if (emailLogIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('email_logs')
      .select('id, opened, opened_at, clicked, clicked_at')
      .in('id', emailLogIds);
    if (!logsError) for (const log of logs || []) emailLogsById.set(log.id, log);
  }

  return rows.map((row) => {
    const emailLog = row.email_log_id ? emailLogsById.get(row.email_log_id) || null : null;
    return {
      id: row.id,
      sequence_id: row.sequence_id,
      sequence_step_id: row.sequence_step_id,
      contact_id: row.contact_id,
      email_log_id: row.email_log_id,
      sent_at: row.sent_at,
      opened: emailLog ? emailLog.opened === true : row.opened === true,
      opened_at: (emailLog && emailLog.opened_at) || row.opened_at || null,
      clicked: emailLog ? emailLog.clicked === true : row.clicked === true,
      clicked_at: (emailLog && emailLog.clicked_at) || row.clicked_at || null,
      status: row.status,
      created_at: row.created_at,
      step: row.sequence_steps || null,
      contact: row.contacts || null,
    };
  });
}

// ─── Recipients (engagement table + manual send) ───────────────────────────

/**
 * Eligible recipients for a sequence node with engagement data.
 *
 * The recipient set comes from the canonical branch resolver (enrolled contacts
 * on this node's parent branch), enriched with:
 *   - the parent-email engagement (email status, opened, clicked, timestamps)
 *   - the sequence enrollment status per contact
 *   - whether the contact already received this node — used by the manual-send
 *     modal to mark "Already Sent".
 */
export async function listSequenceRecipients(sequenceId, stepId) {
  const sequence = await getSequenceRow(sequenceId);
  const { steps } = await loadSequenceContext({ sequence_id: sequenceId });
  const step = stepId ? steps.find((s) => s.id === stepId) : startingNodeOf(steps);
  if (stepId && !step) notFound('Step', stepId);

  const [enrolled, engagement, stepLogResult] = await Promise.all([
    getEnrolledContacts(sequenceId),
    sequenceEngagement(sequenceId),
    step
      ? supabase
          .from(STEP_LOGS_TABLE)
          .select('contact_id')
          .eq('sequence_id', sequenceId)
          .eq('sequence_step_id', step.id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (stepLogResult.error) throw toError(stepLogResult.error, 'Failed to load sent step logs');

  const alreadySent = new Set((stepLogResult.data || []).map((row) => row.contact_id));

  // Branch eligibility + engagement for the PARENT email of each recipient —
  // exactly the data the worker/manual sender uses to gate at send time.
  const eligibility = await getBranchEligibility(
    sequenceId,
    step.id,
    enrolled.map((e) => e.contact_id)
  );

  const rows = enrolled.map((e) => {
    const contact = e.contacts || null;
    const eng = eligibility.get(e.contact_id) || null;
    const sentForStep = alreadySent.has(e.contact_id);

    let status = 'eligible';
    if (sentForStep) status = 'already_sent';
    else if (eng && !eng.eligible) {
      status = eng.opened === true ? 'opened' : 'not_opened';
    }

    return {
      contact: contact
        ? {
            id: contact.id,
            full_name: contact.full_name,
            email: contact.email,
            company: contact.company,
            contact_type: contact.contact_type,
            company_category: contact.company_category,
          }
        : { id: e.contact_id, full_name: null, email: null, company: null, contact_type: null, company_category: null },
      email_status: eng ? eng.email_status : null,
      opened: eng ? eng.opened : null,
      opened_at: eng ? eng.opened_at : null,
      clicked: eng ? eng.clicked : null,
      clicked_at: eng ? eng.clicked_at : null,
      sent_at: eng ? eng.parentSentAt : null,
      last_activity: eng ? eng.opened_at || eng.clicked_at || eng.parentSentAt || null : null,
      sequence_status: e.status,
      already_sent: sentForStep,
      status,
    };
  });

  return {
    sequence: {
      ...sequence,
      engagement,
    },
    step,
    recipients: rows,
  };
}

/**
 * Send the chosen sequence node to the selected recipients right now.
 *
 * Every recipient is re-validated against the canonical branch resolver and the
 * node's duplicate guard (UNIQUE (sequence_id, sequence_step_id, contact_id))
 * BEFORE sending — the frontend selection is never trusted blindly. The
 * recipient's branch (opened / not_opened) is the SAME logic the worker uses.
 *
 * @returns {Promise<{results: Array, sent: number, skipped: number}>}
 */
export async function manualSendSequence(sequenceId, payload) {
  const sequence = await getSequenceRow(sequenceId);
  if (sequence.status !== 'active') {
    badRequest('Sequence must be active before sending manually');
  }
  if (sequence.send_mode === 'automatic') {
    badRequest('This sequence is set to Automatic sending only — manual send is disabled');
  }

  const stepId = requireString(payload && payload.step_id, 'step_id');
  const rawContactIds = payload && payload.contact_ids;
  if (!Array.isArray(rawContactIds) || rawContactIds.length === 0) {
    badRequest('contact_ids must be a non-empty array');
  }

  const step = await stepBelongsToSequence(sequenceId, stepId);

  // Canonical, enrolled, branch-eligible recipient set for THIS node — never
  // the raw payload. `recipients` are enrollment rows carrying the embedded
  // contact; key by CONTACT id (the payload is contact ids).
  const { recipients, eligibility } = await resolveSequenceRecipients(sequenceId, stepId);
  const recipientById = new Map(recipients.map((enrollment) => [enrollment.contact_id, enrollment.contacts]));

  // Already sent for this node (duplicate protection).
  const { data: sentLogs, error: sentLogsError } = await supabase
    .from(STEP_LOGS_TABLE)
    .select('contact_id')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', stepId);
  if (sentLogsError) throw toError(sentLogsError, 'Failed to fetch sent step logs');
  const alreadySent = new Set((sentLogs || []).map((log) => log.contact_id));

  const contactIds = [...new Set(rawContactIds.map((value) => String(value).trim()).filter(Boolean))];

  const campaignId = await ensureSequenceCampaign(sequence);
  const results = [];

  for (const contactId of contactIds) {
    const contact = recipientById.get(contactId);
    if (!contact) {
      results.push({ contact_id: contactId, status: 'ineligible', skipped: true });
      continue;
    }
    if (alreadySent.has(contactId)) {
      results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
      continue;
    }

    // Re-check the node's parent-branch eligibility at send time (same rule as
    // the automatic worker) — never trust an old selection from the UI.
    const elig = eligibility.get(contactId);
    if (!elig || !elig.eligible) {
      results.push({
        contact_id: contactId,
        status: 'ineligible',
        recipient_status: elig && elig.opened === true ? 'opened' : 'not_opened',
        skipped: true,
      });
      continue;
    }

    try {
      const enrollment = { sequence_id: sequenceId, contact_id: contactId };
      const emailType = emailTypeForNode(step);

      // Duplicate guard against a concurrent automatic-worker send racing this
      // manual send: re-verify no step log exists for THIS exact node+recipient
      // immediately before handing the email to the SMTP pipeline. The DB
      // UNIQUE (sequence_id, sequence_step_id, contact_id) is the backstop.
      const { data: raceLog, error: raceError } = await supabase
        .from(STEP_LOGS_TABLE)
        .select('id')
        .eq('sequence_id', sequenceId)
        .eq('sequence_step_id', step.id)
        .eq('contact_id', contactId)
        .maybeSingle();
      if (raceError) throw toError(raceError, 'Failed to re-check sent step log');
      if (raceLog) {
        alreadySent.add(contactId);
        results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
        continue;
      }

      const { log } = await sendStepEmail({
        enrollment,
        campaignId,
        step,
        emailType,
        contact,
      });

      const insertError = await insertStepLog({ enrollment, step, emailLog: log });
      if (insertError && insertError.code === '23505') {
        results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
        continue;
      }
      if (insertError) throw toError(insertError, 'Failed to log sequence step');

      await ensureEnrollmentAndAdvance({ sequenceId, contactId, sequence, contact, step });
      alreadySent.add(contactId);
      results.push({ contact_id: contactId, status: 'sent', email_type: emailType });
    } catch (error) {
      console.error(
        `[sequenceService] Manual send failed for contact ${contactId} (step ${step.step_number}): ${error.message}`
      );
      results.push({ contact_id: contactId, status: 'failed', error: error.message });
    }
  }

  const sent = results.filter((result) => result.status === 'sent').length;
  const scheduled = results.filter((result) => result.status === 'increment_scheduled').length;
  const skipped = results.filter((result) => result.skipped).length;
  return { results, sent, scheduled, skipped };
}

/**
 * Make sure a contact has an enrollment row positioned on the node that was
 * just sent, then branch them forward through the exact same tree walk the
 * automatic worker uses (opened -> opened child; not opened -> not-opened
 * child, scheduled after its wait_hours). Manual sends never bypass the tree.
 */
async function ensureEnrollmentAndAdvance({ sequenceId, contactId, sequence, contact, step }) {
  const nowIso = new Date().toISOString();
  const { data: existing, error: existingError } = await supabase
    .from(ENROLLMENTS_TABLE)
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existingError) throw toError(existingError, 'Failed to check sequence enrollment');

  let enrollment;
  if (existing) {
    const { data, error } = await supabase
      .from(ENROLLMENTS_TABLE)
      .update({
        current_step_id: step.id,
        current_step: Number(step.step_number),
        current_email_type: emailTypeForNode(step),
        status: 'active',
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to update sequence enrollment');
    enrollment = data;
  } else {
    const { data, error } = await supabase
      .from(ENROLLMENTS_TABLE)
      .insert({
        sequence_id: sequenceId,
        contact_id: contactId,
        current_step_id: step.id,
        current_step: Number(step.step_number),
        current_email_type: emailTypeForNode(step),
        status: 'active',
        enrolled_at: nowIso,
        next_run_at: nowIso,
        updated_at: nowIso,
      })
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to create sequence enrollment');
    enrollment = data;
  }

  await advanceAfterSend({ enrollment, sequence, contact });
}
