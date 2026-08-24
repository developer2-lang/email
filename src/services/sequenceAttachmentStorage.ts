/**
 * Sequence attachment Storage path helpers — the Supabase Storage layout.
 *
 * Every sequence gets ONE human-readable root folder built from the REAL
 * sequence name + id read from the `sequences` record (never a subject line or
 * client state):
 *
 *   sequence-attachments/{sequence_name}__{sequence_id}/
 *
 * and inside it a folder for every step / branch, generated from the step's
 * own row (sequence_steps.step_number + parent_branch, or
 * sequence_branch_steps.step + parent_branch):
 *
 *   step-1-starting/      (STARTING / root node)
 *   step-2-opened/        (OPENED branch)
 *   step-2-not-opened/    (NOT_OPENED branch)
 *   step-3-opened/        (…any future step number)
 *   step-3-not-opened/
 *
 * The stored `storage_path` in the attachment tables always equals the real
 * object path, so senders keep working for both new uploads and legacy
 * UUID-only records (those keep their old paths and stay downloadable).
 */
import { supabase } from '../supabase';
import type { StepParentBranch } from '../types/sequence';

export const SEQUENCE_ATTACHMENTS_BUCKET = 'sequence-attachments';

const SEQUENCES_TABLE = 'sequences';
const SEQUENCE_STEPS_TABLE = 'sequence_steps';
const SEQUENCE_BRANCH_STEPS_TABLE = 'sequence_branch_steps';

/**
 * Sanitize a sequence name into a Storage-safe folder name. Unlike file-name
 * sanitization this KEEPS readable spaces and only replaces characters that
 * are unsafe inside a Storage object path, so "Partnership Opportunity"
 * stays "Partnership Opportunity".
 */
export function sanitizeSequenceFolderName(name: string): string {
  const base = String(name || 'untitled-sequence')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'untitled-sequence';
}

/**
 * Folder label for ONE step/branch, generated dynamically from the real step
 * number and branch:
 *
 *   STARTING   → step-{n}-starting
 *   OPENED     → step-{n}-opened
 *   NOT_OPENED → step-{n}-not-opened
 *
 * Works for Step 1, 2, 3, 4, … and any future number — nothing is hardcoded.
 */
export function stepFolderName(
  stepNumber: number | null | undefined,
  parentBranch: StepParentBranch | null | undefined,
): string {
  let n = stepNumber == null ? 1 : Number(stepNumber);
  if (!Number.isFinite(n) || n < 1) n = 1;
  const branch = String(parentBranch || '').trim().toUpperCase();
  const label =
    branch === 'NOT_OPENED'
      ? 'not-opened'
      : branch === 'OPENED'
        ? 'opened'
        : 'starting';
  return `step-${n}-${label}`;
}

/** Root folder for one sequence: `{sequence_name}__{sequence_id}`. */
export function sequenceRootFolderName(sequenceName: string, sequenceId: string): string {
  return `${sanitizeSequenceFolderName(sequenceName)}__${sequenceId}`;
}

/** The sequence fields needed to build the root folder. */
export interface SequenceFolderInfo {
  sequenceId: string;
  sequenceName: string;
  rootFolder: string;
}

/**
 * Read the REAL sequence name + id from the `sequences` record (never a
 * subject line or stale client state) so the root folder always matches the
 * database.
 */
export async function fetchSequenceFolder(sequenceId: string): Promise<SequenceFolderInfo> {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('id, name')
    .eq('id', sequenceId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read the sequence record for the attachment folder: ${error.message}`);
  }
  const id = String(data?.id || sequenceId);
  const sequenceName = data?.name ? String(data.name) : 'untitled-sequence';
  return { sequenceId: id, sequenceName, rootFolder: sequenceRootFolderName(sequenceName, id) };
}

/** The folder + fields resolved for one sequence step node. */
export interface SequenceStepFolder {
  rootFolder: string;
  folder: string;
  sequenceName: string;
  stepNumber: number;
  parentBranch: StepParentBranch;
}

/**
 * Resolve the full Storage folder for ONE `sequence_steps` node:
 *
 *   {sequence_name}__{sequence_id}/step-{n}-{branch}
 *
 * The sequence id is derived from the step record when none is passed, and the
 * real sequence name + step fields are always read from the database.
 */
export async function fetchStepFolder(
  sequenceId: string | null | undefined,
  stepId: string,
): Promise<SequenceStepFolder> {
  const { data: step, error: stepError } = await supabase
    .from(SEQUENCE_STEPS_TABLE)
    .select('sequence_id, step_number, parent_branch')
    .eq('id', stepId)
    .maybeSingle();
  if (stepError) {
    throw new Error(`Failed to read the sequence step for the attachment folder: ${stepError.message}`);
  }
  const seqId = String(step?.sequence_id || sequenceId || '');
  if (!seqId) throw new Error('Could not resolve the sequence for this attachment.');
  const { rootFolder, sequenceName } = await fetchSequenceFolder(seqId);
  const stepNumber = step?.step_number == null ? 1 : Number(step.step_number);
  const parentBranch = (step?.parent_branch as StepParentBranch | null | undefined) || 'STARTING';
  return {
    rootFolder,
    sequenceName,
    stepNumber,
    parentBranch,
    folder: `${rootFolder}/${stepFolderName(stepNumber, parentBranch)}`,
  };
}

/**
 * Resolve the full Storage folder for ONE `sequence_branch_steps` row:
 *
 *   {sequence_name}__{sequence_id}/step-{step}-{branch}
 */
export async function fetchBranchStepFolder(branchStepId: number): Promise<SequenceStepFolder> {
  const { data: row, error } = await supabase
    .from(SEQUENCE_BRANCH_STEPS_TABLE)
    .select('sequence_id, step, parent_branch')
    .eq('id', branchStepId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read the branch step for the attachment folder: ${error.message}`);
  }
  const seqId = String(row?.sequence_id || '');
  if (!seqId) throw new Error('Could not resolve the sequence for this attachment.');
  const { rootFolder, sequenceName } = await fetchSequenceFolder(seqId);
  const stepNumber = row?.step == null ? 1 : Number(row.step);
  const parentBranch = (row?.parent_branch as StepParentBranch | null | undefined) || 'STARTING';
  return {
    rootFolder,
    sequenceName,
    stepNumber,
    parentBranch,
    folder: `${rootFolder}/${stepFolderName(stepNumber, parentBranch)}`,
  };
}