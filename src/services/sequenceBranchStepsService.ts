import { supabase } from '../supabase'
import type { SequenceBranchStep, StepParentBranch } from '../types/sequence'

const BRANCH_STEPS_TABLE = 'sequence_branch_steps'
const SEQUENCES_TABLE = 'sequences'

export interface BranchStepDraft {
  step: number
  parent_step: number | null
  parent_branch: StepParentBranch
  subject: string
  body: string
  wait_hours: number
}

export interface SequenceOption {
  id: string
  name: string
}

/**
 * Fetch the flat branch-tree rows (`sequence_branch_steps`) for one sequence,
 * ordered by step so the UI can render the tree top-down. Rows are scoped by
 * sequence_id — never global.
 */
export async function fetchBranchStepsBySequence(
  sequenceId: string,
): Promise<{ data: SequenceBranchStep[] | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('*')
      .eq('sequence_id', sequenceId)
      .order('step', { ascending: true })
      .order('parent_branch', { ascending: true })
    if (error) return { data: null, error: error.message }
    return { data: (data as SequenceBranchStep[]) || [], error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to fetch branch steps',
    }
  }
}

/** Fetch the available sequences (id + name) for the builder's selector. */
export async function fetchSequencesForBuilder(): Promise<{
  data: SequenceOption[] | null
  error: string | null
}> {
  try {
    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .select('id, name')
      .order('created_at', { ascending: false })
    if (error) return { data: null, error: error.message }
    return { data: (data as SequenceOption[]) || [], error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to fetch sequences',
    }
  }
}

/**
 * Insert a new row into sequence_branch_steps. The current selection's
 * sequence_id is attached automatically so rows are never orphaned.
 */
export async function insertBranchStep(
  sequenceId: string,
  draft: BranchStepDraft,
): Promise<{ data: SequenceBranchStep | null; error: string | null }> {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .insert({
        sequence_id: sequenceId,
        step: draft.step,
        parent_step: draft.parent_step,
        parent_branch: draft.parent_branch,
        subject: draft.subject,
        body: draft.body,
        wait_hours: draft.wait_hours,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()
    if (error) return { data: null, error: error.message }
    return { data: (data as SequenceBranchStep) || null, error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to create branch step',
    }
  }
}

/** Update an existing sequence_branch_steps row by its id. */
export async function updateBranchStepRow(
  id: number,
  draft: BranchStepDraft,
): Promise<{ data: SequenceBranchStep | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .update({
        step: draft.step,
        parent_step: draft.parent_step,
        parent_branch: draft.parent_branch,
        subject: draft.subject,
        body: draft.body,
        wait_hours: draft.wait_hours,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()
    if (error) return { data: null, error: error.message }
    return { data: (data as SequenceBranchStep) || null, error: null }
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Failed to update branch step',
    }
  }
}

/** Delete a single sequence_branch_steps row by its id. */
export async function deleteBranchStepRow(id: number): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(BRANCH_STEPS_TABLE).delete().eq('id', id)
    if (error) return { error: error.message }
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to delete branch step',
    }
  }
}

// ─── Display helpers ────────────────────────────────────────────────────────

/** Label for a parent_step value: NULL -> Starting Step, else "Step N". */
export function parentStepLabel(parentStep: number | null | undefined): string {
  if (parentStep == null) return 'Starting Step'
  return `Step ${parentStep}`
}

/** Label for a parent_branch value. */
export function parentBranchLabel(branch: StepParentBranch | null | undefined): string {
  switch (branch) {
    case 'STARTING':
      return 'Starting'
    case 'OPENED':
      return 'Opened'
    case 'NOT_OPENED':
      return 'Not Opened'
    default:
      return '—'
  }
}

/** Tag CSS class for a parent_branch value (reuses existing tag palette). */
export function parentBranchTagClass(branch: StepParentBranch | null | undefined): string {
  switch (branch) {
    case 'OPENED':
      return 'tag-startup'
    case 'NOT_OPENED':
      return 'tag-oem'
    default:
      return 'tag-client'
  }
}

/** Label for a wait_hours value: 0 -> Immediate, else "X hours". */
export function waitHoursLabel(waitHours: number | null | undefined): string {
  const h = Number(waitHours)
  if (!Number.isFinite(h) || h <= 0) return 'Immediate'
  return `${h} hour${h === 1 ? '' : 's'}`
}