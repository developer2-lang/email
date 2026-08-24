/**
 * Sequence automation worker — recursive branch-tree workflow.
 *
 * Every row in `sequence_steps` is a NODE in a branching tree:
 *
 *   parent_step_id  -> the exact parent node this node extends (NULL = the
 *                      STARTING step / Step 1).
 *   parent_branch   -> 'STARTING' | 'OPENED' | 'NOT_OPENED' (NOT NULL) — which
 *                      path of the parent node this node lives on; the root
 *                      node stores 'STARTING'.
 *
 * A node may have at most one 'OPENED' child and one 'NOT_OPENED' child
 * (UNIQUE (sequence_id, parent_step_id, parent_branch)). `step_number` is a
 * display depth only, shared by siblings (Step 2 has two rows, etc.).
 *
 * FLOW (per enrolled recipient):
 *   - The STARTING step (parent_step_id IS NULL) is sent to EVERY enrolled
 *     recipient immediately after activation.
 *   - After a step's email is sent, the recipient BRANCHES by whether they
 *     OPENED that step's email (re-read from tracking data on every tick):
 *       opened     -> advance onto the parent's 'OPENED' child node; that
 *                     node's email is sent on the very next tick.
 *       not opened -> advance onto the parent's 'NOT_OPENED' child node; that
 *                     node's email is sent after its own wait_hours — but
 *                     ONLY IF the parent email is STILL not opened by then.
 *                     If the recipient opens during the wait, they are
 *                     re-routed to the parent's 'OPENED' child instead.
 *   - BOTH branches ALWAYS send their configured next email. NOT_OPENED never
 *     means STOP. A node with no children keeps the enrollment active and
 *     re-checks (auto-recovery) so children added AFTER sending resume the
 *     chain automatically; the branch ends ("completed") only after that node's
 *     OWN wait_hours elapse since its email was sent (a wait-0 leaf completes
 *     immediately).
 *
 * This is parent-step gating: CURRENT STEP + PARENT STEP + PARENT BRANCH
 * RESULT (opened OR not_opened) — never opened-only progression. The worker
 * drives both branch transitions and both branches' delayed / immediate
 * emails. `handleStepOpened` (hooked into the tracking service) makes the
 * opened branch advance immediately on a real open instead of waiting for the
 * next poll.
 *
 * Waits are PER RECIPIENT: wait_hours = 0 makes the next branch email due on
 * the next tick; wait_hours = N schedules it N hours after that recipient's
 * branch-determining event (the parent email send).
 *
 * Duplicate protection: UNIQUE (sequence_id, sequence_step_id, contact_id) on
 * sequence_step_logs is the authoritative guard, plus the atomic next_run_at
 * claim. If a step is already logged, the worker advances without resending
 * (self-healing after a crash between send and state-write). Failed sends are
 * marked "failed" on the email_log and retried RETRY_DELAY_SECONDS later.
 *
 * Email content/merge-tag/tracking reuse the exact campaign pipeline
 * (emailService, emailLogService, utils/emailTemplate.js). The content of a
 * 'NOT_OPENED' node uses its INCREMENT variant (falling back to NORMAL);
 * every other node uses the NORMAL variant.
 */
import * as emailService from '../services/emailService.js';
import * as emailLogService from '../services/emailLogService.js';
import {
  personalizeTemplate,
  stripHtml,
  buildTrackedHtml,
  decodeHtmlEntities,
  hasHtmlTags,
  plainTextToHtml,
} from '../utils/emailTemplate.js';
import { supabase, fetchTemplateHtml } from '../services/supabaseService.js';
import trackingConfig from '../config/tracking.js';
import trackingEdge from '../config/trackingEdge.js';

const CHECK_INTERVAL_MS = 60 * 1000; // check once per minute
const CLAIM_LOCK_MS = Math.max(
  60 * 1000,
  parseInt(process.env.SEQUENCE_CLAIM_LOCK_MS, 10) || 5 * 60 * 1000
);
const RETRY_DELAY_SECONDS = Math.max(
  60,
  parseInt(process.env.SEQUENCE_RETRY_DELAY_SECONDS, 10) || 300
);
// Paces consecutive sends so a batch of due enrollments never bursts emails
// back-to-back — bursts trigger Gmail's rate limiter ("421 4.7.0") and hurt
// deliverability. Matches the campaign worker's ~1 message/second cadence.
const SEND_DELAY_MS = (() => {
  const value = parseInt(process.env.SEQUENCE_SEND_DELAY_MS, 10);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
})();
// Default wait when a step has no wait_hours (old default was 24h).
const DEFAULT_WAIT_HOURS = 24;

// Attachment tables read when sending a node's email. Normal Sequence-page
// attachments live against sequence_steps (sequence_step_attachments); Sequence
// Builder attachments live against the mirror sequence_branch_steps row
// (sequence_branch_step_attachments). BOTH are loaded for the EXACT node being
// sent — files from other steps/branches are never attached.
const STEP_ATTACHMENTS_TABLE = 'sequence_step_attachments';
const BRANCH_STEP_ATTACHMENTS_TABLE = 'sequence_branch_step_attachments';
const ATTACHMENTS_BUCKET = 'sequence-attachments';
// Poll cadence while waiting for an open on the 'OPENED' branch.
const RECHECK_OPENED_MS = 60 * 1000;
// Minimum time a recipient stays PARKED on a sent node before the OPENED /
// NOT_OPENED branch decision is made. Open events arrive via tracking only
// AFTER the email is sent (a human must actually open it), so deciding any
// sooner would commit everyone to the NOT_OPENED child before any open exists —
// the OPENED branch would never send (Eligible > 0 but Sent = 0). The decision
// waits the node's own wait_hours AND at least this window. Configurable via
// SEQUENCE_OPEN_WINDOW_MS (ms).
const OPEN_DETECTION_WINDOW_MS = Math.max(
  CHECK_INTERVAL_MS,
  parseInt(process.env.SEQUENCE_OPEN_WINDOW_MS, 10) || 10 * 60 * 1000
);

// Enrollment ids currently being processed — prevents duplicate sends within
// this process (the atomic claim guards across ticks/processes).
const _processing = new Set();

let _timer = null;
let _checking = false;
let _trackingEnabled = null;

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  return wrapped;
}

/**
 * Delay (ms) before a node's email is due. Prefers the per-step auto-send
 * configuration (send_after_value + send_after_unit: minutes/hours/days) and
 * falls back to the legacy integer wait_hours for steps that predate it.
 */
function waitMsOf(step) {
  const value = Number(step && step.send_after_value);
  const unit = step && step.send_after_unit;
  if (
    Number.isFinite(value) &&
    value >= 0 &&
    (unit === 'minutes' || unit === 'hours' || unit === 'days')
  ) {
    const perUnit =
      unit === 'minutes' ? 60 * 1000 : unit === 'hours' ? 3600 * 1000 : 24 * 3600 * 1000;
    return value * perUnit;
  }
  const h = Number(step && step.wait_hours);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_WAIT_HOURS) * 3600 * 1000;
}

/**
 * One-time check that the optional open/click tracking columns exist on
 * email_logs (the tracking migration has been applied). Cached for the
 * process lifetime.
 */
async function trackingEnabled() {
  if (_trackingEnabled === null) {
    const { error } = await supabase
      .from('email_logs')
      .select('tracking_id, opened, clicked')
      .limit(1);
    _trackingEnabled = !(error && error.code === '42703');
  }
  return _trackingEnabled;
}

// ─── Discovery + claiming ──────────────────────────────────────────────────

async function getActiveSequenceIds() {
  const { data, error } = await supabase
    .from('sequences')
    .select('id')
    .eq('status', 'active');
  if (error) throw toError(error, 'Failed to list active sequences');
  return (data || []).map((s) => s.id);
}

/**
 * Fetch enrollments that are due right now. Contacts and the owning sequence
 * are embedded so the worker does not need extra round-trips per row.
 *
 * NO batch cap: a step with wait_hours=0 (Immediate) must send to EVERY due
 * enrollment in the same tick. Burst pacing is handled by SEND_DELAY_MS below,
 * not by leaving recipients behind for a later tick.
 */
async function getDueEnrollments(sequenceIds) {
  if (sequenceIds.length === 0) return [];
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select(
      '*, sequences(id, campaign_id, name, status, recipient_type, send_mode), ' +
      'contacts(*)'
    )
    .in('sequence_id', sequenceIds)
    .eq('status', 'active')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true });
  if (error) throw toError(error, 'Failed to fetch due sequence enrollments');
  return data || [];
}

/**
 * Re-read one enrollment with its sequence + contact embedded (the row the
 * chain loop needs after a step was advanced, since `moveEnrollmentTo` updates
 * the DB but not the in-memory object).
 */
async function reloadEnrollment(enrollmentId) {
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .select(
      '*, sequences(id, campaign_id, name, status, recipient_type, send_mode), ' +
      'contacts(*)'
    )
    .eq('id', enrollmentId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to reload sequence enrollment');
  return data || null;
}

/**
 * Revive enrollments that COMPLETED while their node was a leaf, when that node
 * has since gained children (a branch step was added AFTER the enrollment
 * ended). Such enrollments are stranded forever otherwise: `getDueEnrollments`
 * only sees ACTIVE rows and completed rows carry `next_run_at = NULL`.
 *
 * This is fully recursive and step-number agnostic — it never knows (or cares)
 * which step number any node is:
 *
 *   - If the enrollment's current step is ACTIVE and gained children after it
 *     completed, it is revived in place.
 *   - If the enrollment's current step is ARCHIVED (the branch was deleted /
 *     re-saved), the nearest ACTIVE ancestor is located by walking up
 *     `parent_step_id`; if THAT ancestor gained children after completion, the
 *     enrollment is re-parented onto it and revived, so the recreated branch
 *     continues instead of ending.
 *
 * Only enrollments whose completion PREDATES the child's creation are revived
 * (enrollment.updated_at vs the step's latest non-archived child
 * created_at), so genuinely-ended branches are never churned back to life, and
 * already-resumed rows (which complete again on their new leaf) stay put.
 *
 * @param {string[]} sequenceIds - Active sequence ids being checked.
 * @returns {Promise<number>} How many enrollments were revived.
 */
async function resumeCompletedEnrollments(sequenceIds) {
  if (!sequenceIds || sequenceIds.length === 0) return 0;

  // Only automatic sequences can be resumed — manual-send sequences are
  // user-driven and must never be auto-advanced by the worker.
  const { data: sequences, error: seqError } = await supabase
    .from('sequences')
    .select('id, status, send_mode')
    .in('id', sequenceIds);
  if (seqError) throw toError(seqError, 'Failed to list sequences for resume');
  const activeAuto = (sequences || []).filter(
    (s) => s.status === 'active' && s.send_mode !== 'manual'
  );
  if (activeAuto.length === 0) return 0;
  const activeIds = activeAuto.map((s) => s.id);

  // Fetch ALL steps (archived included) so archived current steps can be
  // re-parented to their nearest live ancestor.
  const { data: steps, error: stepsError } = await supabase
    .from('sequence_steps')
    .select('id, sequence_id, parent_step_id, step_number, created_at, archived_at')
    .in('sequence_id', activeIds);
  if (stepsError) throw toError(stepsError, 'Failed to fetch sequence steps for resume');

  const stepById = new Map();
  const latestChildByStep = new Map();
  for (const step of steps || []) {
    stepById.set(step.id, step);
    if (step.parent_step_id && !step.archived_at) {
      const existing = latestChildByStep.get(step.parent_step_id);
      if (!existing || step.created_at > existing) {
        latestChildByStep.set(step.parent_step_id, step.created_at);
      }
    }
  }
  if (stepById.size === 0 || latestChildByStep.size === 0) return 0;

  // Nearest ACTIVE ancestor of a step (walks up archived parents). Returns the
  // live node a stranded enrollment should re-join from, or null if the whole
  // ancestry is archived (nothing to route from).
  const activeAncestor = (stepId, seen = new Set()) => {
    if (!stepId || seen.has(stepId)) return null;
    seen.add(stepId);
    const step = stepById.get(stepId);
    if (!step) return null;
    if (!step.archived_at) return step;
    return activeAncestor(step.parent_step_id, seen);
  };

  const { data: enrollments, error: enrollError } = await supabase
    .from('sequence_enrollments')
    .select('id, contact_id, sequence_id, current_step_id, updated_at')
    .in('sequence_id', activeIds)
    .eq('status', 'completed')
    .not('current_step_id', 'is', null);
  if (enrollError) throw toError(enrollError, 'Failed to fetch completed sequence enrollments');

  const nowIso = new Date().toISOString();
  let revived = 0;
  for (const enrollment of enrollments || []) {
    const currentStep = stepById.get(enrollment.current_step_id);
    const anchor = currentStep && !currentStep.archived_at
      ? currentStep
      : activeAncestor(enrollment.current_step_id);
    if (!anchor) continue;

    const childCreated = latestChildByStep.get(anchor.id);
    if (!childCreated) continue;
    const completedAt = enrollment.updated_at
      ? new Date(enrollment.updated_at).getTime()
      : 0;
    if (completedAt >= new Date(childCreated).getTime()) continue;

    // Re-parenting is only needed when the enrollment was parked on an archived
    // node — re-join from the nearest live ancestor.
    const reparent = anchor.id !== enrollment.current_step_id;
    const { error: upError } = await supabase
      .from('sequence_enrollments')
      .update(
        reparent
          ? {
              status: 'active',
              current_step_id: anchor.id,
              current_step: Number(anchor.step_number),
              current_email_type: emailTypeForNode(anchor),
              next_run_at: nowIso,
              updated_at: nowIso,
            }
          : { status: 'active', next_run_at: nowIso, updated_at: nowIso }
      )
      .eq('id', enrollment.id)
      .eq('status', 'completed');
    if (upError) {
      console.error(`[SeqWorker] Failed to revive enrollment ${enrollment.id}: ${upError.message}`);
      continue;
    }
    revived += 1;
    console.log(
      reparent
        ? `[SeqWorker] Revived + re-parented completed enrollment ${enrollment.id} — archived step ${enrollment.current_step_id} → live step ${anchor.id}; continuing from there`
        : `[SeqWorker] Revived completed enrollment ${enrollment.id} — step ${enrollment.current_step_id} gained children after completion`
    );
  }
  return revived;
}

/**
 * Atomically claim a due enrollment so only ONE tick/worker ever sends its
 * current step. Pushing next_run_at into the future means a concurrent tick's
 * `next_run_at <= now` WHERE clause fails and it skips. The real next_run_at is
 * written when processing finishes (success or reschedule).
 *
 * @returns {Promise<boolean>} true when this run won the claim
 */
async function claimEnrollment(enrollmentId) {
  const nowIso = new Date().toISOString();
  const lockUntil = new Date(Date.now() + CLAIM_LOCK_MS).toISOString();
  const { data, error } = await supabase
    .from('sequence_enrollments')
    .update({ next_run_at: lockUntil, updated_at: nowIso })
    .eq('id', enrollmentId)
    .eq('status', 'active')
    .lte('next_run_at', nowIso)
    .select('id')
    .maybeSingle();
  if (error) throw toError(error, 'Failed to claim sequence enrollment');
  return data != null;
}

// ─── Context + tree helpers ────────────────────────────────────────────────

/**
 * Load every step node of a sequence and resolve the enrollment's CURRENT node.
 * The enrollment tracks the exact node via `current_step_id`; `current_step`
 * is only a display depth (legacy rows without current_step_id fall back to
 * the starting node / step number).
 */
async function loadSequenceContext(enrollment) {
  const { data: steps, error } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', enrollment.sequence_id)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (error) throw toError(error, 'Failed to fetch sequence steps');

  // Self-heal: legacy step logs written without email_log_id get linked to
  // their real email_log row so tracking data reaches eligibility/branching.
  // Cached per sequence inside the helper — a no-op after the first run.
  await emailLogService.backfillStepLogEmailLinks(enrollment.sequence_id);

  const stepsList = steps || [];
  const startingStep =
    stepsList.find((s) => s.parent_step_id === null) || stepsList[0] || null;

  let currentStep = null;
  if (enrollment.current_step_id) {
    currentStep = stepsList.find((s) => s.id === enrollment.current_step_id) || null;
  }
  if (!currentStep) {
    const stepNumber = Number(enrollment.current_step);
    currentStep =
      stepsList.find((s) => Number(s.step_number) === stepNumber) || startingStep;
  }
  return { steps: stepsList, startingStep, currentStep };
}

async function getStepLog(sequenceId, contactId, stepId) {
  if (!stepId) return null;
  const { data, error } = await supabase
    .from('sequence_step_logs')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .eq('sequence_step_id', stepId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence step log');
  return data || null;
}

async function getEmailLog(emailLogId) {
  if (!emailLogId) return null;
  const { data, error } = await supabase
    .from('email_logs')
    .select('id, status, opened, opened_at, clicked, clicked_at, sent_at')
    .eq('id', emailLogId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence email log');
  return data || null;
}

function childrenOf(steps, stepId) {
  return (steps || []).filter((s) => s.parent_step_id === stepId);
}

/**
 * Which email variant a node uses: 'NOT_OPENED' nodes use their INCREMENT
 * ("Not Opened") content (falling back to NORMAL); every other node uses the
 * NORMAL ("Opened") content.
 */
function emailTypeForNode(step) {
  return step && step.parent_branch === 'NOT_OPENED' ? 'increment' : 'normal';
}

/**
 * CENTRAL node eligibility — the single source of truth for "is this recipient
 * on this node's branch?" shared by the worker, the Step Progress table, the
 * recipients UI and manual send.
 *
 * Branch membership is decided by the PARENT node's email tracking:
 *   'OPENED'     -> the parent email was opened.
 *   'NOT_OPENED' -> the parent email was sent but NOT opened.
 * The STARTING node has no parent -> always eligible.
 *
 * @returns {Promise<object>} { eligible, branch, opened, parentSentAt,
 *   parentEmailLogId }
 */
async function evaluateNodeEligibility({ sequenceId, contactId, step }) {
  if (!step.parent_step_id) {
    return {
      eligible: true,
      branch: 'starting',
      opened: null,
      opened_at: null,
      email_status: null,
      parentSentAt: null,
      parentEmailLogId: null,
    };
  }
  const parentLog = await getStepLog(sequenceId, contactId, step.parent_step_id);
  if (!parentLog) {
    return {
      eligible: false,
      branch: 'none',
      opened: null,
      opened_at: null,
      email_status: null,
      parentSentAt: null,
      parentEmailLogId: null,
      reason: 'parent_not_sent',
    };
  }
  // The linked email_log is the authoritative tracking record. When the row is
  // missing (legacy sends written without the link) fall back to the step log's
  // OWN tracking columns so recipients are never stranded at eligible=0.
  const emailLog = parentLog.email_log_id ? await getEmailLog(parentLog.email_log_id) : null;
  const sent = !!(emailLog ? emailLog.status === 'sent' : parentLog.status === 'sent');
  const opened = !!(emailLog ? emailLog.opened === true : parentLog.opened === true);
  const openedAt = (emailLog && emailLog.opened_at) || parentLog.opened_at || null;
  const clicked = !!(emailLog ? emailLog.clicked === true : parentLog.clicked === true);
  const clickedAt = (emailLog && emailLog.clicked_at) || parentLog.clicked_at || null;
  const branch = step.parent_branch === 'NOT_OPENED' ? 'not_opened' : 'opened';
  const parentSkipped = parentLog.status === 'skipped';

  // Parent skipped -> the next linear step proceeds without open tracking.
  let eligible =
    parentSkipped ||
    (branch === 'not_opened' ? sent && opened === false : opened === true);

  // Linear time-based chain: the OPENED child becomes eligible as soon as the
  // parent email is sent (regardless of an open) when it is the parent's only
  // child (no NOT_OPENED sibling). Real branch trees keep the open gate.
  if (
    !eligible &&
    branch === 'opened' &&
    sent &&
    (await isLinearChild(sequenceId, step))
  ) {
    eligible = true;
  }

  return {
    eligible,
    branch,
    opened,
    parent_skipped: parentSkipped,
    opened_at: openedAt,
    email_status: (emailLog && emailLog.status) || parentLog.status || 'sent',
    parentSentAt: parentLog.sent_at || (emailLog && emailLog.sent_at) || null,
    parentEmailLogId: parentLog.email_log_id || null,
    clicked,
    clicked_at: clickedAt,
  };
}

/**
 * DB-backed linear-child check used by evaluateNodeEligibility (which does not
 * hold the full tree). Mirrors isLinearFromSteps for the per-contact path.
 */
async function isLinearChild(sequenceId, step) {
  if (!step || !step.parent_step_id) return false;
  const { data: siblings } = await supabase
    .from('sequence_steps')
    .select('parent_branch')
    .eq('sequence_id', sequenceId)
    .eq('parent_step_id', step.parent_step_id)
    .is('archived_at', null);
  const list = siblings || [];
  return list.length > 0 && list.every((s) => s.parent_branch === 'OPENED');
}

/**
 * Batched branch eligibility for many contacts (Step Progress + recipients UI +
 * manual send). Same logic as evaluateNodeEligibility, but the parent step
 * logs + email logs are fetched once instead of per contact.
 *
 * @returns {Promise<Map<string, object>>} contact_id -> eligibility row
 */
async function getBranchEligibility(sequenceId, stepId, contactIds) {
  const { steps } = await loadSequenceContext({ sequence_id: sequenceId });
  const step = steps.find((s) => s.id === stepId) || null;
  const map = new Map();
  if (!step || !contactIds || contactIds.length === 0) return map;

  if (!step.parent_step_id) {
    for (const id of contactIds) {
      map.set(id, {
        eligible: true,
        branch: 'starting',
        opened: null,
        email_status: null,
        opened_at: null,
        clicked: null,
        clicked_at: null,
        parentSentAt: null,
        parentEmailLogId: null,
      });
    }
    return map;
  }

  const { data: parentLogs, error } = await supabase
    .from('sequence_step_logs')
    .select('contact_id, email_log_id, sent_at, status, opened, opened_at, clicked, clicked_at')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', step.parent_step_id)
    .in('contact_id', contactIds);
  if (error) {
    console.error(
      `[DEBUG getBranchEligibility] seq=${sequenceId} step=${stepId} parent=${step.parent_step_id} contacts=${JSON.stringify(contactIds)} → ${error.message}`
    );
    throw toError(error, 'Failed to fetch parent step logs');
  }


  const logByContact = new Map((parentLogs || []).map((l) => [l.contact_id, l]));
  const emailLogIds = [
    ...new Set((parentLogs || []).map((l) => l.email_log_id).filter(Boolean)),
  ];
  const emailById = new Map();
  if (emailLogIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('email_logs')
      .select('id, status, opened, opened_at, clicked, clicked_at, sent_at')
      .in('id', emailLogIds);
    if (logsError) throw toError(logsError, 'Failed to fetch parent email logs');
    for (const log of logs || []) emailById.set(log.id, log);
  }

  const branch = step.parent_branch === 'NOT_OPENED' ? 'not_opened' : 'opened';
  const linearChild = isLinearFromSteps(steps, step);
  for (const id of contactIds) {
    const parentLog = logByContact.get(id);
    if (!parentLog) {
      map.set(id, {
        eligible: false,
        branch: 'none',
        opened: null,
        email_status: null,
        opened_at: null,
        clicked: null,
        clicked_at: null,
        parentSentAt: null,
        parentEmailLogId: null,
        reason: 'parent_not_sent',
      });
      continue;
    }
    // Authoritative tracking = the linked email_log; fall back to the step
    // log's OWN columns when the link is missing (legacy rows).
    const emailLog = parentLog.email_log_id
      ? emailById.get(parentLog.email_log_id) || null
      : null;
    const sent = !!(emailLog ? emailLog.status === 'sent' : parentLog.status === 'sent');
    const opened = !!(emailLog ? emailLog.opened === true : parentLog.opened === true);
    const openedAt = (emailLog && emailLog.opened_at) || parentLog.opened_at || null;
    const clicked = !!(emailLog ? emailLog.clicked === true : parentLog.clicked === true);
    const clickedAt = (emailLog && emailLog.clicked_at) || parentLog.clicked_at || null;
    const parentSkipped = parentLog.status === 'skipped';
    const eligible =
      parentSkipped ||
      (branch === 'not_opened' ? sent && opened === false : opened === true) ||
      (!opened && sent && linearChild && branch === 'opened');
    map.set(id, {
      eligible,
      branch,
      opened,
      parent_skipped: parentSkipped,
      email_status: (emailLog && emailLog.status) || parentLog.status || 'sent',
      opened_at: openedAt,
      clicked,
      clicked_at: clickedAt,
      parentSentAt: parentLog.sent_at || (emailLog && emailLog.sent_at) || null,
      parentEmailLogId: parentLog.email_log_id || null,
    });
  }
  return map;
}

// ─── Sending ──────────────────────────────────────────────────────────────

/**
 * Resolve the sequence_branch_steps row id that mirrors a sequence_steps node
 * (same sequence_id + step_number + parent_branch). Sequence Builder
 * attachments are keyed by that branch-step id, so this is how a node being
 * sent finds its OWN builder attachments — never another branch's files.
 */
async function branchStepIdForNode(sequenceId, step) {
  if (!step || step.step_number == null || !step.parent_branch) return null;
  const { data, error } = await supabase
    .from('sequence_branch_steps')
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('step', Number(step.step_number))
    .eq('parent_branch', step.parent_branch)
    .maybeSingle();
  if (error) return null;
  return data ? data.id : null;
}

/** Best-effort load of one attachment metadata table (missing table → []). */
async function loadAttachmentRecords(table, column, key) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq(column, key)
    .order('created_at', { ascending: true });
  if (error) {
    // The table may not be migrated on older databases — degrade to no files
    // instead of failing the send. Any other error is a real failure.
    if (error.code === '42P01') {
      console.warn(`[SeqWorker] ${table} missing (42P01) — sending without those attachments`);
      return [];
    }
    throw error;
  }
  return data || [];
}

/** Download one attachment record from Storage into a nodemailer-ready object. */
async function attachmentForMail(att) {
  const bucket = String(att.storage_bucket || ATTACHMENTS_BUCKET);
  const path = String(att.storage_path || '');
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `Failed to download attachment "${att.file_name || path}" from Storage — bucket="${bucket}" path="${path}"${error ? `: ${error.message}` : ' (empty response)'}`
    );
  }
  const content = Buffer.from(await data.arrayBuffer());
  return { filename: att.file_name || 'attachment', content };
}

/**
 * Load the files to ride with THIS node's email: the node's own
 * sequence_step_attachments plus the Sequence Builder attachments on the
 * sequence_branch_steps row that mirrors this node. Never files from another
 * step or another branch.
 */
async function loadStepAttachmentsForNode(sequenceId, step) {
  const records = [];
  if (step && step.id) {
    const stepAtts = await loadAttachmentRecords(STEP_ATTACHMENTS_TABLE, 'sequence_step_id', step.id);
    if (stepAtts) records.push(...stepAtts);
  }
  const branchStepId = await branchStepIdForNode(sequenceId, step);
  if (branchStepId != null) {
    const branchAtts = await loadAttachmentRecords(BRANCH_STEP_ATTACHMENTS_TABLE, 'branch_step_id', branchStepId);
    if (branchAtts) records.push(...branchAtts);
  }
  if (records.length === 0) return [];
  const attachments = [];
  for (const att of records) {
    attachments.push(await attachmentForMail(att));
  }
  return attachments;
}

/**
 * Make sure the sequence has its own dedicated (hidden) campaign, creating one
 * lazily on first use. Sequence email_logs then reference THIS campaign so
 * sequence sends/opens never pollute any campaign analytics.
 *
 * Idempotent under concurrent ticks: whoever wins the `campaign_id IS NULL`
 * claim owns the sequence's campaign; losers delete their duplicate.
 *
 * @param {object} sequence - Sequence row (must include id, name, campaign_id).
 * @returns {Promise<string>} The campaign id to log sequence emails under.
 */
async function ensureSequenceCampaign(sequence) {
  if (sequence.campaign_id) return sequence.campaign_id;

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .insert({
      campaign_name: `__sequence__${String(sequence.name || 'untitled').slice(0, 80)}`,
      subject_line: 'Sequence email',
      from_name: '',
      campaign_type: 'sequence',
      status: 'draft',
      audience_segment: null,
    })
    .select('id')
    .single();
  if (error) throw toError(error, 'Failed to create sequence campaign');

  const { error: claimError } = await supabase
    .from('sequences')
    .update({ campaign_id: campaign.id, updated_at: new Date().toISOString() })
    .eq('id', sequence.id)
    .is('campaign_id', null);
  if (claimError) throw toError(claimError, 'Failed to link sequence campaign');

  // A concurrent tick may have won the claim first — then drop our duplicate
  // campaign and use theirs.
  const { data: refreshed, error: refreshError } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', sequence.id)
    .maybeSingle();
  if (refreshError) throw toError(refreshError, 'Failed to re-read sequence campaign');

  const winnerId = refreshed && refreshed.campaign_id;
  if (winnerId && winnerId !== campaign.id) {
    // Another tick won the claim — drop our duplicate campaign.
    try {
      await supabase.from('campaigns').delete().eq('id', campaign.id);
    } catch (e) {
      console.warn(`[SeqWorker] Failed to delete duplicate sequence campaign ${campaign.id}: ${e.message}`);
    }
    return winnerId;
  }
  return campaign.id;
}

/**
 * Send one sequence step email, mirroring the campaign worker's personalise +
 * track + send pipeline. Emails are logged under the sequence's DEDICATED
 * campaign (`campaignId`).
 *
 * @param {object} options
 * @param {string} options.campaignId - The sequence's dedicated campaign id.
 * @returns {Promise<{log: object, result: object}>} email_log row + SMTP result
 */
/**
 * Resolve the HTML body for a step send: when the step references a template
 * (normal_template_id / increment_template_id), the ORIGINAL template HTML is
 * fetched from the templates table / Storage at send time so template edits
 * propagate to the send (the stored body is only a copy). Falls back to the
 * stored body when there is no template reference or the fetch fails.
 */
async function resolveStepBodyHtml(step, emailType) {
  const isIncrement = emailType === 'increment';
  const templateId = isIncrement ? step.increment_template_id : step.normal_template_id;
  const storedBody = isIncrement ? step.increment_body : step.normal_body;
  if (templateId) {
    try {
      const html = await fetchTemplateHtml(templateId);
      if (html && String(html).trim()) {
        console.log(
          `[SeqWorker] Step ${step.id} uses template ${templateId} — ` +
          `fetched ORIGINAL template HTML (${html.length} chars).`
        );
        return html;
      }
    } catch (err) {
      console.warn(
        `[SeqWorker] Failed to fetch template ${templateId} for step ${step.id}: ` +
        `${err.message} — falling back to stored body.`
      );
    }
  }
  return storedBody || '';
}

async function sendStepEmail({ enrollment, campaignId, step, emailType, contact }) {
  const { subject } = resolveStepContent(step, emailType);
  const body = await resolveStepBodyHtml(step, emailType);

  const decoded = decodeHtmlEntities(personalizeTemplate(body || '', contact));
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);
  const subjectLine = personalizeTemplate(subject || '', contact);

  const [log] = await emailLogService.createEmailLogs([
    {
      campaign_id: campaignId,
      contact_id: enrollment.contact_id,
      email: contact.email,
      status: 'pending',
    },
  ]);
  if (!log) throw new Error('Failed to create email log for sequence send');

  let htmlToSend = personalizedHtml;
  const tracking = (await trackingEnabled()) && trackingConfig.baseUrl && log.tracking_id;
  if (tracking) {
    htmlToSend = buildTrackedHtml(
      personalizedHtml,
      log.tracking_id,
      trackingConfig.baseUrl,
      campaignId,
      enrollment.contact_id
    );
  } else if (await trackingEnabled()) {
    const missing = !trackingConfig.baseUrl
      ? 'TRACKING_BASE_URL is not set'
      : 'email_log.tracking_id is missing';
    console.warn(
      `[SeqWorker] ${missing} — legacy Express open/click links are NOT embedded. ` +
      `Edge-mode pixel (TRACKING_MODE=edge) is still appended when enabled. ` +
      `Sending sequence email to ${contact.email}`
    );
  }

  // EDGE-mode (test-only): additionally append the Supabase Edge Function pixel.
  if (trackingEdge.isEdge) {
    const { html: withEdgePixel } = trackingEdge.appendEdgeTrackingPixel(
      htmlToSend,
      campaignId,
      contact.email,
      log.tracking_id || null
    );
    htmlToSend = withEdgePixel;
  }

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  console.log(`[Personalization] recipient=${contact.email}`);
  console.log(`[Personalization] contact_id=${contact.id || enrollment.contact_id || '(none)'}`);
  console.log(`[Personalization] full_name=${contact.full_name || ''}`);
  console.log(`[Personalization] company=${contact.company || ''}`);
  console.log(`[Personalization] designation=${contact.designation || ''}`);
  console.log(`[Personalization] rendered_subject=${String(subjectLine || '').slice(0, 200)}`);
  console.log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  try {
    const result = await emailService.sendEmail({
      to: contact.email,
      subject: subjectLine,
      html: htmlToSend,
      text: plainText,
      campaignId,
      recipientId: enrollment.contact_id,
      trackingId: log.tracking_id,
      attachments: await loadStepAttachmentsForNode(enrollment.sequence_id, step),
    });
    await emailLogService.updateEmailLog(log.id, {
      status: 'sent',
      sent_at: new Date().toISOString(),
    });
    return { log, result };
  } catch (error) {
    await emailLogService
      .updateEmailLog(log.id, {
        status: 'failed',
        error_message: error.message,
        last_attempt_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw error;
  }
}

function resolveStepContent(step, emailType) {
  if (
    emailType === 'increment' &&
    step.increment_subject &&
    step.increment_body
  ) {
    return { subject: step.increment_subject, body: step.increment_body };
  }
  return { subject: step.normal_subject, body: step.normal_body };
}

/**
 * Write the step log linking a sent sequence email to its real email_log row.
 * `email_log_id` is the branch's tracking link — without it eligibility can
 * never read the parent email's open/click record. When the row already exists
 * (retry / duplicate / legacy row written without the link), the email_log_id
 * is back-filled so existing data self-heals instead of going dead.
 */
async function insertStepLog({ enrollment, step, emailLog }) {
  if (!emailLog || !emailLog.id) {
    throw new Error('Cannot log sequence step without an email_log_id — aborting to avoid a broken branch link');
  }
  const { error } = await supabase.from('sequence_step_logs').insert({
    sequence_id: enrollment.sequence_id,
    sequence_step_id: step.id,
    contact_id: enrollment.contact_id,
    email_log_id: emailLog.id,
    sent_at: new Date().toISOString(),
    opened: false,
    clicked: false,
    status: 'sent',
  });
  if (error && error.code === '23505') {
    // A step log already exists for this node+contact. Fill in the missing
    // email_log_id so the row is trackable from now on.
    await supabase
      .from('sequence_step_logs')
      .update({ email_log_id: emailLog.id })
      .eq('sequence_id', enrollment.sequence_id)
      .eq('sequence_step_id', step.id)
      .eq('contact_id', enrollment.contact_id)
      .is('email_log_id', null);
  }
  return error;
}

/**
 * Log a deliberately-skipped step (Send Action = "Skip This Step"). No email is
 * created — just a step log marked 'skipped' with no email_log_id so the send
 * history shows exactly what happened and the chain can keep moving. `sent_at`
 * records when the skip was processed so the next step times its delay from it.
 */
async function insertSkippedStepLog({ enrollment, step }) {
  const { error } = await supabase.from('sequence_step_logs').insert({
    sequence_id: enrollment.sequence_id,
    sequence_step_id: step.id,
    contact_id: enrollment.contact_id,
    email_log_id: null,
    sent_at: new Date().toISOString(),
    opened: false,
    clicked: false,
    status: 'skipped',
  });
  return error;
}

/**
 * Advance an enrollment PAST a skipped step without sending anything. The step
 * is "Continue to the next configured step": the enrollment moves onto the
 * skipped node's OPENED child (the next linear step) due after that child's own
 * send-after delay; when there is no next step the enrollment completes.
 * Idempotent — a crash after logging the skip just re-runs the advance.
 */
async function advanceSkippedStep({ enrollment, sequence, context, currentStep, contact }) {
  const children = childrenOf(context.steps, currentStep.id);
  const openedChild = children.find((c) => c.parent_branch === 'OPENED') || null;
  const recipient = (contact && contact.email) || enrollment.contact_id;

  if (!openedChild) {
    await completeEnrollment(enrollment.id);
    console.log(
      `[SeqWorker] ${recipient} skipped step ${currentStep.step_number} (no next step) — sequence completed`
    );
    return { completed: true, skipped: true };
  }

  const atMs = Date.now() + waitMsOf(openedChild);
  const atIso = new Date(atMs).toISOString();
  await moveEnrollmentTo(enrollment.id, openedChild, atIso);
  console.log(
    `[SeqWorker] ${recipient} skipped step ${currentStep.step_number} — advancing to step ${openedChild.step_number} (send after delay), due ${atIso}`
  );
  return { skipped: true, advancedTo: openedChild.step_number, scheduled_for: atIso };
}

/**
 * Is a node a "linear" child — the only child of its parent, on the OPENED
 * branch (no NOT_OPENED sibling)? Linear chains are the Sequence Builder's flat
 * up-to-6-step sequences: their next email is due on a pure timer once the
 * previous email is sent, regardless of opens. Real branch trees have both
 * children, so this is false there.
 */
function isLinearFromSteps(steps, childStep) {
  if (!childStep || !childStep.parent_step_id) return false;
  const siblings = (steps || []).filter((s) => s.parent_step_id === childStep.parent_step_id);
  return siblings.length > 0 && siblings.every((s) => s.parent_branch === 'OPENED');
}

// ─── State advancement (branch tree) ───────────────────────────────────────

async function moveEnrollmentTo(enrollmentId, step, atIso) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('sequence_enrollments')
    .update({
      current_step_id: step.id,
      current_step: Number(step.step_number),
      current_email_type: emailTypeForNode(step),
      status: 'active',
      next_run_at: atIso,
      updated_at: nowIso,
    })
    .eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to advance sequence enrollment');
}

async function completeEnrollment(enrollmentId) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('sequence_enrollments')
    .update({
      status: 'completed',
      next_run_at: null,
      current_email_type: 'normal',
      updated_at: nowIso,
    })
    .eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to complete sequence enrollment');
}

/**
 * Branch a recipient forward AFTER its current node's email was sent (or found
 * already sent). Both branches advance:
 *
 *   opened     -> onto the node's 'OPENED' child (email due next tick).
 *   not opened -> onto the node's 'NOT_OPENED' child (email due after that
 *                 child's wait_hours — the branch is re-checked from tracking
 *                 when it comes due, and an open during the wait re-routes the
 *                 recipient to the 'OPENED' child instead).
 *
 * A node with no matching child keeps the enrollment ACTIVE and re-checks for a
 * newly-added child (auto-recovery), ending the branch only after the node's OWN
 * wait_hours elapse since its email was sent (wait-0 leaves complete instantly).
 * NOT_OPENED never means STOP.
 */
async function advanceAfterSend({ enrollment, sequence, contact }) {
  const context = await loadSequenceContext(enrollment);
  const currentStep = context.currentStep;
  if (!currentStep) {
    await completeEnrollment(enrollment.id);
    return { completed: true };
  }

  const stepLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
  const emailLog = stepLog && stepLog.email_log_id ? await getEmailLog(stepLog.email_log_id) : null;
  const opened = !!(emailLog ? emailLog.opened === true : stepLog && stepLog.opened === true);
  const nowMs = Date.now();
  const sentMs = stepLog && stepLog.sent_at ? new Date(stepLog.sent_at).getTime() : nowMs;
  const openedMs = emailLog && emailLog.opened_at
    ? new Date(emailLog.opened_at).getTime()
    : stepLog && stepLog.opened_at
      ? new Date(stepLog.opened_at).getTime()
      : sentMs;
  const recipient = (contact && contact.email) || enrollment.contact_id;

  const children = childrenOf(context.steps, currentStep.id);
  const openedChild = children.find((c) => c.parent_branch === 'OPENED') || null;
  const notOpenedChild = children.find((c) => c.parent_branch === 'NOT_OPENED') || null;

  // OPENED FAST PATH — an open already recorded on this node's OWN email
  // (edge-mode tracking writes email_logs directly; legacy tracking
  // additionally fires handleStepOpened) advances the recipient to the OPENED
  // child NOW instead of waiting out the whole open-detection window. The
  // child's email is due at (open time + child.wait_hours), so wait_hours=0
  // sends immediately.
  if (opened && openedChild) {
    const atMs = openedMs + waitMsOf(openedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, openedChild, atIso);
    console.log(
      `[SeqWorker] ${recipient} step ${currentStep.step_number} opened (recorded within detection window) — advancing to step ${openedChild.step_number} (opened), due ${atIso}`
    );
    return {
      advancedTo: openedChild.step_number,
      advancedToId: openedChild.id,
      branch: 'opened',
      scheduled_for: atIso,
    };
  }

  if (opened) {
    // Opened but no 'OPENED' child exists yet — auto-recovery: keep the
    // enrollment ACTIVE and re-check so a child added later resumes the chain.
    return leafRecheck({
      enrollment,
      step: currentStep,
      sentMs,
      branch: 'opened',
      nowMs,
      recipient,
      stepNumber: currentStep.step_number,
    });
  }

  // BRANCH DECISION IS DEFERRED — never decide opened vs. not-opened in the
  // same tick the email was sent (opened is almost always false at the instant
  // of the send, so everyone would be committed to the NOT_OPENED child before
  // real open events exist). The recipient stays PARKED ON THE NOT_OPENED CHILD
  // (visible pending state, no email sent) until this node's OWN configured
  // wait period (wait_hours) AND the open-detection window have elapsed since
  // the email was sent — at least one poll interval — then the ACTUAL open
  // tracking state is read and the NOT_OPENED email is sent on its own due
  // time. An open recorded during the parked window re-routes the recipient
  // immediately via handleStepOpened (trackingService). This also stops wait-0
  // children from firing the whole chain in a single tick.
  if (notOpenedChild) {
    const decisionAtMs =
      sentMs + Math.max(waitMsOf(currentStep), OPEN_DETECTION_WINDOW_MS);
    if (nowMs < decisionAtMs) {
      // Re-check at least once a minute so a LATE-RECORDED open (edge-mode
      // tracking that writes email_logs directly, a delayed pixel, or an open
      // that landed just after the send) is still detected promptly instead of
      // making the recipient wait out the full detection window.
      const atIso = new Date(
        Math.min(decisionAtMs, nowMs + CHECK_INTERVAL_MS)
      ).toISOString();
      await moveEnrollmentTo(enrollment.id, notOpenedChild, atIso);
      console.log(
        `[SeqWorker] ${recipient} step ${currentStep.step_number} email sent — waiting for open tracking, parked on step ${notOpenedChild.step_number} (not opened), branch decision due ${atIso}`
      );
      return {
        waiting: true,
        advancedTo: notOpenedChild.step_number,
        advancedToId: notOpenedChild.id,
        branch: 'not_opened',
        scheduled_for: atIso,
      };
    }

    // Decision window elapsed AND still not opened — the NOT_OPENED branch is
    // ready. The child's email is due after its OWN wait_hours (0 = next tick).
    const atMs = sentMs + waitMsOf(notOpenedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, notOpenedChild, atIso);
    console.log(
      `[SeqWorker] ${recipient} did not open step ${currentStep.step_number} — advancing to step ${notOpenedChild.step_number} (not opened), due ${atIso}`
    );
    return { advancedTo: notOpenedChild.step_number, advancedToId: notOpenedChild.id, branch: 'not_opened', scheduled_for: atIso };
  }

  if (openedChild) {
    // Linear time-based chain (this node's ONLY child is its OPENED child — no
    // NOT_OPENED sibling): the Recipient advances on the timer regardless of an
    // open, and this node's next email is due after the child's send-after.
    const atMs = sentMs + waitMsOf(openedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, openedChild, atIso);
    console.log(
      `[SeqWorker] ${recipient} step ${currentStep.step_number} — linear sequence, advancing to step ${openedChild.step_number} (send after delay), due ${atIso}`
    );
    return { advancedTo: openedChild.step_number, advancedToId: openedChild.id, branch: 'opened', scheduled_for: atIso };
  }

  // Not opened and no 'NOT_OPENED' child exists yet — same auto-recovery (a
  // real open during the wait re-routes to the opened child via handleStepOpened).
  return leafRecheck({
    enrollment,
    step: currentStep,
    sentMs,
    branch: 'not_opened',
    nowMs,
    recipient,
    stepNumber: currentStep.step_number,
  });
}

/**
 * Auto-recovery for a node whose email was already sent but currently has no
 * child of the recipient's branch. Instead of ending the branch immediately
 * (which permanently strands enrollments when steps are added AFTER sending),
 * the enrollment stays ACTIVE and re-checks every RECHECK_OPENED_MS for a
 * newly-added child. Once the node's OWN wait_hours have elapsed since the
 * email was sent (a wait-0 leaf: immediately), the branch ends ("completed").
 */
async function leafRecheck({ enrollment, step, sentMs, branch, nowMs, recipient, stepNumber }) {
  const deadline = sentMs + waitMsOf(step);
  if (nowMs >= deadline) {
    await completeEnrollment(enrollment.id);
    console.log(
      `[SeqWorker] ${recipient} step ${stepNumber} (${branch}) has no matching child within the re-check window — branch ends (completed)`
    );
    return { completed: true, branch };
  }
  const atIso = new Date(Math.max(nowMs, sentMs) + RECHECK_OPENED_MS).toISOString();
  await moveEnrollmentTo(enrollment.id, step, atIso);
  console.log(
    `[SeqWorker] ${recipient} step ${stepNumber} (${branch}) has no matching child yet — keeping active, re-check ${atIso}`
  );
  return { waiting: true, branch, scheduled_for: atIso };
}

// ─── Per-enrollment processing ────────────────────────────────────────────

/**
 * Handle a due enrollment that is NOT yet eligible for its current node
 * (parent branch gate). Re-schedules the re-check or re-routes the recipient:
 *
 *   - 'OPENED' branch, parent email not opened yet     -> poll RECHECK_OPENED_MS
 *     (a real open via handleStepOpened advances it immediately).
 *   - 'NOT_OPENED' branch, still within its wait       -> re-check at
 *     parentSentAt + node.wait_hours.
 *   - parent email opened while on the 'NOT_OPENED' node (opened during the
 *     wait) -> re-route to the parent's 'OPENED' child.
 */
async function handleNotEligible({ enrollment, sequence, context, currentStep, elig, contact }) {
  const nowMs = Date.now();

  if (elig.branch === 'not_opened' && elig.parentSentAt) {
    const parentSentMs = new Date(elig.parentSentAt).getTime();
    const atMs = parentSentMs + waitMsOf(currentStep);

    if (elig.opened === true) {
      // Opened during the wait — belongs on the parent's 'OPENED' child.
      const parent = context.steps.find((s) => s.id === currentStep.parent_step_id) || null;
      const openedChild = parent
        ? childrenOf(context.steps, parent.id).find((c) => c.parent_branch === 'OPENED') || null
        : null;
      if (openedChild) {
        await moveEnrollmentTo(enrollment.id, openedChild, new Date(nowMs).toISOString());
        console.log(
          `[SeqWorker] ${(contact && contact.email) || enrollment.contact_id} opened during the wait — re-routing to step ${openedChild.step_number} (opened)`
        );
        return { rerouted: true, to: openedChild.step_number, branch: 'opened' };
      }
      // Opened during the wait but the parent has no 'OPENED' child YET — keep
      // the enrollment ACTIVE, parked on the parent, and re-check so a child
      // added later resumes the branch (auto-recovery) instead of ending it.
      if (parent) {
        const atIso = new Date(nowMs + RECHECK_OPENED_MS).toISOString();
        await moveEnrollmentTo(enrollment.id, parent, atIso);
        console.log(
          `[SeqWorker] ${(contact && contact.email) || enrollment.contact_id} opened during the wait — parent step ${parent.step_number} has no OPENED child yet; keeping active, re-check ${atIso}`
        );
        return { waiting: true, parked_on: parent.step_number, scheduled_for: atIso };
      }
      await completeEnrollment(enrollment.id);
      return { completed: true, reason: 'opened_no_opened_child' };
    }

    const atIso = new Date(Math.max(atMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
    await moveEnrollmentTo(enrollment.id, currentStep, atIso);
    console.log(
      `[SeqWorker] ${(contact && contact.email) || enrollment.contact_id} waiting for step ${currentStep.step_number} (not opened) — re-check ${atIso}`
    );
    return { waiting: true, scheduled_for: atIso };
  }

  if (elig.branch === 'opened' && elig.eligible) {
    // Recipient opened the parent email but the OPENED node's own wait_hours
    // has not elapsed yet — park the enrollment until event + wait.
    const eventMs = elig.opened_at
      ? new Date(elig.opened_at).getTime()
      : elig.parentSentAt
        ? new Date(elig.parentSentAt).getTime()
        : nowMs;
    const atMs = eventMs + waitMsOf(currentStep);
    const atIso = new Date(Math.max(atMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
    await moveEnrollmentTo(enrollment.id, currentStep, atIso);
    console.log(
      `[SeqWorker] ${(contact && contact.email) || enrollment.contact_id} waiting for step ${currentStep.step_number} (opened) — re-check ${atIso}`
    );
    return { waiting: true, scheduled_for: atIso };
  }

  // Waiting for an open on the 'OPENED' branch (or the parent email itself).
  const atIso = new Date(nowMs + RECHECK_OPENED_MS).toISOString();
  await moveEnrollmentTo(enrollment.id, currentStep, atIso);
  return { waiting: true, scheduled_for: atIso };
}

/**
 * Process one claimed, due enrollment.
 */
async function processDueEnrollment(enrollment) {
  const sequence = enrollment.sequences;
  if (!sequence) return { skipped: true };

  // Manual-send sequences are user-driven — the worker never auto-sends or
  // auto-advances them; manual sends own the whole tree walk for their step.
  if (sequence.send_mode === 'manual') {
    return { skipped: true, reason: 'manual_sequence_user_triggered' };
  }

  const context = await loadSequenceContext(enrollment);
  const currentStep = context.currentStep;
  if (!currentStep) {
    console.error(
      `[SeqWorker] Enrollment ${enrollment.id} has no current step node — marking completed`
    );
    await completeEnrollment(enrollment.id);
    return { completed: true };
  }

  const contact = enrollment.contacts || {};

  // Skip This Step: never send the email. Log the skip (once) and advance to
  // the next configured step. Runs BEFORE the already-logged check so a crash
  // after logging the skip simply re-advances on the next tick (idempotent).
  if (currentStep.send_action === 'skip') {
    const skipLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
    if (!skipLog) {
      const skipError = await insertSkippedStepLog({ enrollment, step: currentStep });
      if (skipError && skipError.code !== '23505') {
        throw toError(skipError, 'Failed to log skipped sequence step');
      }
    }
    return advanceSkippedStep({ enrollment, sequence, context, currentStep, contact });
  }

  // Already logged for this node (crash recovery / normal advance): branch the
  // recipient forward WITHOUT resending.
  const existingStepLog = await getStepLog(
    sequence.id,
    enrollment.contact_id,
    currentStep.id
  );
  if (existingStepLog) {
    return advanceAfterSend({ enrollment, sequence, contact });
  }

  // STARTING node (Step 1): every enrolled recipient is eligible right away.
  if (!currentStep.parent_step_id) {
    return processStepSend({ enrollment, sequence, context, currentStep, contact });
  }

  const elig = await evaluateNodeEligibility({
    sequenceId: sequence.id,
    contactId: enrollment.contact_id,
    step: currentStep,
  });

  // DIAGNOSTIC — branch send decision for this recipient (temporary).
  console.log(
    '[SEQUENCE]', sequence.id,
    '[STEP]', `${currentStep.id}/${currentStep.step_number}`,
    '[PARENT]', currentStep.parent_step_id,
    '[BRANCH]', currentStep.parent_branch,
    '[WAIT_HOURS]', currentStep.wait_hours,
    '[ELIGIBLE]', elig.eligible,
    '[ALREADY_SENT]', !!existingStepLog,
    '[READY_TO_SEND]', elig.eligible && !existingStepLog,
    '[RECIPIENT]', enrollment.contact_id,
    (contact && contact.email) || ''
  );

  if (elig.branch === 'not_opened') {
    const parentSentMs = elig.parentSentAt ? new Date(elig.parentSentAt).getTime() : nowIsoMs();
    const atMs = parentSentMs + waitMsOf(currentStep);
    const eligibleNow = elig.eligible && atMs <= Date.now();
    if (!eligibleNow) {
      return handleNotEligible({ enrollment, sequence, context, currentStep, elig, contact });
    }
    // Wait elapsed AND still not opened — the NOT_OPENED branch sends now.
    return processStepSend({ enrollment, sequence, context, currentStep, contact });
  }

  if (elig.eligible) {
    // 'OPENED' branch — parent email opened. Respect THIS node's saved
    // wait_hours: send immediately only when the wait is 0, otherwise keep the
    // recipient pending until (open time + wait_hours) elapses.
    const eventMs = elig.opened_at
      ? new Date(elig.opened_at).getTime()
      : elig.parentSentAt
        ? new Date(elig.parentSentAt).getTime()
        : nowIsoMs();
    const atMs = eventMs + waitMsOf(currentStep);
    if (atMs > Date.now()) {
      return handleNotEligible({ enrollment, sequence, context, currentStep, elig, contact });
    }
    return processStepSend({ enrollment, sequence, context, currentStep, contact });
  }

  return handleNotEligible({ enrollment, sequence, context, currentStep, elig, contact });
}

// Safety bound for the chain walk (bounded in practice by tree depth).
const MAX_CHAIN_DEPTH = 100;

/**
 * Process one enrollment through the whole wait-0 branch chain in a single
 * tick. `processDueEnrollment` handles ONE step; when the next child is ALREADY
 * due (wait_hours = 0 → due at the parent's send/open time, which is in the
 * past) this re-runs it immediately instead of leaving the recipient for the
 * next tick. The walk stops as soon as the enrollment completes, fails, or is
 * scheduled for a future time, so it can never spin.
 */
async function processEnrollmentChain(initial) {
  let enrollment = initial;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const result = await processDueEnrollment(enrollment);
    if (result.skipped || result.failed || result.completed) return result;

    // Re-read the row: a successful send may have advanced the recipient onto a
    // child that is already due — continue the chain right away.
    const fresh = await reloadEnrollment(enrollment.id);
    if (!fresh || fresh.status !== 'active') return result;
    const dueMs = fresh.next_run_at ? new Date(fresh.next_run_at).getTime() : 0;
    if (dueMs > Date.now()) return result;
    enrollment = fresh;
  }
  console.warn(`[SeqWorker] Chain walk for enrollment ${initial.id} hit MAX_CHAIN_DEPTH — leaving to next tick`);
  return { looped: true };
}

function nowIsoMs() {
  return Date.now();
}

/**
 * Send one node's email through the shared pipeline, log it
 * (duplicate-protected) and branch the recipient forward. Used by the
 * automatic worker for BOTH the opened and the not-opened branches.
 */
async function processStepSend({ enrollment, sequence, context, currentStep, contact }) {
  const nowIso = new Date().toISOString();
  const emailType = emailTypeForNode(currentStep);

  try {
    // Last-line duplicate guard: processDueEnrollment already skips enrollments
    // whose current node is logged, but a concurrent manual send (which claims
    // the same enrollment) could advance it between that check and now. Re-check
    // the exact node+recipient right before handing the email to the SMTP
    // pipeline so a recipient is NEVER sent the same sequence branch email twice
    // (UNIQUE (sequence_id, sequence_step_id, contact_id) is the DB backstop).
    const recheckLog = await getStepLog(
      sequence.id,
      enrollment.contact_id,
      currentStep.id
    );
    if (recheckLog) {
      const advanced = await advanceAfterSend({ enrollment, sequence, contact });
      return { sent: false, already_logged: true, ...advanced };
    }

    // Dedicated campaign per sequence — created lazily on the first email.
    const campaignId = await ensureSequenceCampaign(sequence);
    sequence.campaign_id = campaignId;

    // DIAGNOSTIC — immediately before handing the email to the provider (temporary).
    console.log(
      '[SENDING]', (contact && contact.email) || enrollment.contact_id,
      '[STEP]', `${currentStep.id}/${currentStep.step_number}`,
      '[PARENT]', currentStep.parent_step_id,
      '[BRANCH]', currentStep.parent_branch,
      '[SEQUENCE]', sequence.id
    );

    const { log } = await sendStepEmail({
      enrollment,
      campaignId,
      step: currentStep,
      emailType,
      contact,
    });

    const insertError = await insertStepLog({ enrollment, step: currentStep, emailLog: log });
    if (insertError && insertError.code === '23505') {
      console.warn(
        `[SeqWorker] Step ${currentStep.step_number} already logged for ${enrollment.contact_id} (unique guard) — advancing`
      );
    } else if (insertError) {
      throw toError(insertError, 'Failed to log sequence step');
    }

    // DIAGNOSTIC — after the provider send + DB log succeeded (temporary).
    console.log('[SENT]', (contact && contact.email) || enrollment.contact_id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[SEQUENCE]', sequence.id);

    const advanced = await advanceAfterSend({ enrollment, sequence, contact });

    // DIAGNOSTIC — the dynamically-found child for this recipient (temporary).
    console.log(
      '[NEXT_CHILD]', JSON.stringify({
        sequence: sequence.id,
        fromStep: `${currentStep.id}/${currentStep.step_number}`,
        branch: advanced.branch || null,
        childId: advanced.advancedToId || null,
        childNumber: advanced.advancedTo || null,
        status: advanced.completed ? 'completed'
          : advanced.waiting ? `waiting until ${advanced.scheduled_for}`
          : 'advanced',
      })
    );

    console.log(
      `[SeqWorker] Sent step ${currentStep.step_number} (${emailType}) to ${(contact && contact.email) || enrollment.contact_id} — ` +
      (advanced.completed ? 'branch ends (completed)'
        : advanced.waiting ? `parked on step ${currentStep.step_number} until ${advanced.scheduled_for}`
        : `next step ${advanced.advancedTo} (${advanced.branch})`)
    );
    return { sent: true, emailType, ...advanced };
  } catch (error) {
    // DIAGNOSTIC — the provider send failed for this recipient (temporary).
    console.log('[SEND_FAILED]', (contact && contact.email) || enrollment.contact_id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[ERROR]', error.message);
    console.error(
      `[SeqWorker] FAILED to send step ${currentStep.step_number} (${emailType}) to ${(contact && contact.email) || enrollment.contact_id}: ${error.message}`
    );
    await supabase
      .from('sequence_enrollments')
      .update({
        next_run_at: new Date(Date.now() + RETRY_DELAY_SECONDS * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', enrollment.id);
    return { failed: true };
  }
}

// ─── Open hook (tracking integration) ─────────────────────────────────────

/**
 * Called by the tracking service when a sequence step email is opened. Advances
 * the recipient onto the step's 'OPENED' child immediately (email due next
 * tick) so the OPENED branch does not wait for the next poll. Best-effort and
 * idempotent — never throws.
 *
 * @param {object} emailLog - { id, campaign_id, contact_id }
 * @returns {Promise<object|null>} the opened child node or null
 */
export async function handleStepOpened(emailLog) {
  if (!emailLog || !emailLog.id || !emailLog.contact_id) return null;
  try {
    // Resolve the full email_log row (campaign_id + sent_at are needed to match
    // legacy step logs that were written without the email_log_id link).
    let log = emailLog;
    if (!log.campaign_id || !log.sent_at) {
      const { data: row } = await supabase
        .from('email_logs')
        .select('id, campaign_id, contact_id, sent_at')
        .eq('id', emailLog.id)
        .maybeSingle();
      if (!row) return null;
      log = row;
    }

    let { data: stepLog } = await supabase
      .from('sequence_step_logs')
      .select('sequence_id, sequence_step_id, contact_id')
      .eq('email_log_id', log.id)
      .maybeSingle();

    // Legacy rows carry no link. Locate the owning sequence via its dedicated
    // campaign, self-heal every unlinked step log of that sequence, then retry
    // the link lookup — the open still advances the recipient's OPENED branch.
    if (!stepLog && log.campaign_id && log.contact_id) {
      const { data: sequence } = await supabase
        .from('sequences')
        .select('id')
        .eq('campaign_id', log.campaign_id)
        .maybeSingle();
      if (sequence) {
        await emailLogService.backfillStepLogEmailLinks(sequence.id);
        const { data: relinked } = await supabase
          .from('sequence_step_logs')
          .select('sequence_id, sequence_step_id, contact_id')
          .eq('email_log_id', log.id)
          .maybeSingle();
        stepLog = relinked || null;
      }
    }

    if (!stepLog) {
      console.error(`[DEBUG handleStepOpened] no step_log for email_log ${log.id}`);
      return null;
    }
    const sequenceId = stepLog.sequence_id;
    const contactId = stepLog.contact_id;

    const { data: openedChild } = await supabase
      .from('sequence_steps')
      .select('*')
      .eq('sequence_id', sequenceId)
      .eq('parent_step_id', stepLog.sequence_step_id)
      .eq('parent_branch', 'OPENED')
      .is('archived_at', null)
      .limit(1)
      .maybeSingle();
    if (!openedChild) {
      console.error(`[DEBUG handleStepOpened] no opened child for parent ${stepLog.sequence_step_id}`);
      return null;
    }

    const { data: enrollment, error: enrollmentError } = await supabase
      .from('sequence_enrollments')
      .select('id, sequence_id, contact_id, status, current_step_id')
      .eq('sequence_id', sequenceId)
      .eq('contact_id', contactId)
      .maybeSingle();
    if (enrollmentError) throw toError(enrollmentError, 'Failed to load enrollment for open');
    if (!enrollment || enrollment.status !== 'active') {
      console.error(`[DEBUG handleStepOpened] enrollment missing/inactive contact=${contactId}: ${JSON.stringify(enrollment)}`);
      return null;
    }

    // The recipient is on the opened step itself (open landed before the worker
    // advanced it) OR on the step's not_opened child (opened during the wait).
    // Both route onto the opened child immediately. Deeper descendants are left
    // to the worker's normal due-time re-check (handleNotEligible) so this hook
    // never diverges from the polled branch logic.
    const { data: notOpenedChild } = await supabase
      .from('sequence_steps')
      .select('id')
      .eq('sequence_id', sequenceId)
      .eq('parent_step_id', stepLog.sequence_step_id)
      .eq('parent_branch', 'NOT_OPENED')
      .is('archived_at', null)
      .limit(1)
      .maybeSingle();
    const onOpenedStep = enrollment.current_step_id === stepLog.sequence_step_id;
    const onNotOpenedChild = !!notOpenedChild && enrollment.current_step_id === notOpenedChild.id;
    if (!onOpenedStep && !onNotOpenedChild) {
      console.error(`[DEBUG handleStepOpened] not on opened/not_opened node: enrollment=${enrollment.current_step_id} step=${stepLog.sequence_step_id} notOpened=${notOpenedChild && notOpenedChild.id}`);
      return null;
    }

    const existing = await getStepLog(sequenceId, contactId, openedChild.id);
    if (existing) {
      console.error(`[DEBUG handleStepOpened] step_log already exists for opened child ${openedChild.id}`);
      return null;
    }

    const nowIso = new Date().toISOString();
    // The opened child respects its OWN saved wait_hours: it becomes due at
    // (open time + child.wait_hours), not on the next tick, unless wait is 0.
    const dueAt = new Date(Date.now() + waitMsOf(openedChild)).toISOString();
    await supabase
      .from('sequence_enrollments')
      .update({
        current_step_id: openedChild.id,
        current_step: Number(openedChild.step_number),
        current_email_type: 'normal',
        status: 'active',
        next_run_at: dueAt,
        updated_at: nowIso,
      })
      .eq('id', enrollment.id);
    console.log(
      `[SeqWorker] Open on step ${stepLog.sequence_step_id} for contact ${contactId} — advanced to opened child step ${openedChild.step_number}, due ${dueAt}`
    );
    return openedChild;
  } catch (error) {
    console.error(`[SeqWorker] handleStepOpened failed (non-fatal): ${error.message}`);
    return null;
  }
}

// ─── Scheduler loop ───────────────────────────────────────────────────────

/**
 * One full tick: find due enrollments across active sequences and process each.
 * Guarded so concurrent ticks never overlap.
 *
 * @param {string[]} [sequenceIdsOverride] optional — when given, ONLY those
 *   sequences are evaluated (used by activation and by tests so a tick never
 *   touches unrelated live sequences).
 */
async function checkDueEnrollments(sequenceIdsOverride) {
  console.log('[DEBUG checkDueEnrollments] ENTER t=' + Date.now() + ' checking=' + _checking);
  if (_checking) return;
  _checking = true;
  try {
    const sequenceIds = sequenceIdsOverride || (await getActiveSequenceIds());

    // Revive completed enrollments whose step gained children after they ended
    // (steps added post-send), so the tree never strands a branch permanently.
    // Runs every tick AND before every triggered check (activation, step add).
    const revived = await resumeCompletedEnrollments(sequenceIds);
    if (revived > 0) {
      console.log(`[SeqWorker] Revived ${revived} completed enrollment(s) that gained children — resuming`);
    }

    const due = await getDueEnrollments(sequenceIds);
    console.log(`[SeqWorker] Checking due sequence enrollments — ${due.length} due`);

    for (const enrollment of due) {
      if (_processing.has(enrollment.id)) continue;

      const claimed = await claimEnrollment(enrollment.id);
      if (!claimed) {
        console.log(`[SeqWorker] Enrollment ${enrollment.id} claimed by another run — skipping`);
        continue;
      }

      _processing.add(enrollment.id);
      console.log('[DEBUG checkDueEnrollments] process ' + enrollment.id + ' seq=' + (enrollment.sequences && enrollment.sequences.send_mode) + ' t=' + Date.now());
      try {
        await processEnrollmentChain(enrollment);
      } catch (error) {
        console.error(`[SeqWorker] Failed to process enrollment ${enrollment.id}: ${error.message}`);
      } finally {
        _processing.delete(enrollment.id);
      }

      // Pace sends between enrollments so bursts of due emails never hit
      // Gmail's SMTP rate limit.
      if (SEND_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
      }
    }

    // Debug snapshot — exact recipient IDs per step (temporary, for verification).
    // Log for explicitly-checked sequences (tests/activations) always, and for
    // auto-ticks only when the tick actually processed due enrollments.
    const processedSet = new Set(due.map((d) => d.sequence_id));
    if (sequenceIdsOverride) {
      for (const sid of sequenceIds) await logBranchSnapshot(sid);
    } else if (due.length > 0) {
      for (const sid of processedSet) await logBranchSnapshot(sid);
    }
  } catch (error) {
    console.error(`[SeqWorker] Error while checking due enrollments: ${error.message}`);
  } finally {
    console.log('[DEBUG checkDueEnrollments] EXIT t=' + Date.now());
    _checking = false;
  }
}

/**
 * Debug snapshot (temporary, REQUIRED for verification): after a tick, print the
 * EXACT recipient IDs per step, computed per recipient from the PARENT step's
 * real email open state — never from counts, ordering or step-number arithmetic.
 *
 *   STEP N ELIGIBLE / SENT / OPENED / NOT_OPENED: recipient IDs = [...]
 *
 * Labels: OPENED child -> "N", NOT_OPENED child -> "N A".
 */
async function logBranchSnapshot(sequenceId) {
  try {
    const { steps } = await loadSequenceContext({ sequence_id: sequenceId });
    if (!steps || steps.length === 0) return;

    const { data: enr } = await supabase
      .from('sequence_enrollments')
      .select('contact_id')
      .eq('sequence_id', sequenceId);
    const enrolled = [...new Set((enr || []).map((e) => e.contact_id))];

    const { data: logs } = await supabase
      .from('sequence_step_logs')
      .select('sequence_step_id, contact_id, email_log_id, status')
      .eq('sequence_id', sequenceId);
    const stepLogs = logs || [];

    const emailLogIds = [...new Set(stepLogs.map((l) => l.email_log_id).filter(Boolean))];
    const emailMap = new Map();
    if (emailLogIds.length > 0) {
      const { data: emails } = await supabase
        .from('email_logs')
        .select('id, opened')
        .in('id', emailLogIds);
      for (const e of emails || []) emailMap.set(e.id, e.opened === true);
    }

    const logsByStep = new Map();
    for (const l of stepLogs) {
      if (!logsByStep.has(l.sequence_step_id)) logsByStep.set(l.sequence_step_id, []);
      logsByStep.get(l.sequence_step_id).push(l);
    }

    const label = (step) =>
      step.parent_branch === 'NOT_OPENED'
        ? `${step.step_number}A`
        : String(step.step_number);
    const fmt = (ids) => `[${[...new Set(ids)].join(', ')}]`;

    for (const step of steps) {
      const logs = logsByStep.get(step.id) || [];
      const sent = logs.filter((l) => l.status === 'sent').map((l) => l.contact_id);
      const opened = logs
        .filter((l) => l.status === 'sent' && emailMap.get(l.email_log_id) === true)
        .map((l) => l.contact_id);
      const notOpened = logs
        .filter((l) => l.status === 'sent' && emailMap.get(l.email_log_id) !== true)
        .map((l) => l.contact_id);

      let eligible = [];
      if (!step.parent_step_id) {
        eligible = enrolled;
      } else {
        for (const pl of logsByStep.get(step.parent_step_id) || []) {
          const parentOpened = emailMap.get(pl.email_log_id);
          const qualifies =
            step.parent_branch === 'NOT_OPENED'
              ? pl.status === 'sent' && parentOpened !== true
              : parentOpened === true;
          if (qualifies) eligible.push(pl.contact_id);
        }
      }

      console.log(`[BRANCH] STEP ${label(step)} ELIGIBLE: recipient IDs = ${fmt(eligible)}`);
      console.log(`[BRANCH] STEP ${label(step)} SENT: recipient IDs = ${fmt(sent)}`);
      console.log(`[BRANCH] STEP ${label(step)} OPENED: recipient IDs = ${fmt(opened)}`);
      console.log(`[BRANCH] STEP ${label(step)} NOT_OPENED: recipient IDs = ${fmt(notOpened)}`);
    }
  } catch (error) {
    console.error(`[BRANCH] snapshot failed for sequence ${sequenceId}: ${error.message}`);
  }
}

/**
 * Start the sequence worker. Runs one immediate check (so anything already due
 * is picked up right after a backend restart) and then checks once per minute.
 */
function startSequenceWorker() {
  if (_timer) return;
  console.log('[SeqWorker] Started');
  console.log('[SeqWorker] Checking every 60 seconds');

  void checkDueEnrollments();

  _timer = setInterval(() => {
    void checkDueEnrollments();
  }, CHECK_INTERVAL_MS);
}

export {
  startSequenceWorker,
  checkDueEnrollments,
  processDueEnrollment,
  processEnrollmentChain,
  claimEnrollment,
  getDueEnrollments,
  resumeCompletedEnrollments,
  waitMsOf as stepDelayMs,
  // Shared send pipeline — reused by the sequence service for manual sends so
  // automatic and manual sends go through the exact same email pipeline.
  ensureSequenceCampaign,
  sendStepEmail,
  insertStepLog,
  emailTypeForNode,
  // Shared tree logic — the single source of truth for branch membership.
  loadSequenceContext,
  evaluateNodeEligibility,
  getBranchEligibility,
  advanceAfterSend,
};
