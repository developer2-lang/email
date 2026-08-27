-- Email Intelligence — safe sequence step deletion
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Supports deleting a step without destroying historical data:
--   - sequence_steps.archived_at is a soft-delete flag. Steps that have
--     already sent emails (send/tracking history in sequence_step_logs +
--     email_logs) are archived instead of removed so every join stays intact.
--   - Archived steps are excluded from the branch tree by every reader
--     (workers + service) via `archived_at IS NULL` filters.
--   - The unique branch slot (one 'opened' + one 'not_opened' child per parent)
--     ignores archived rows, so a replacement step can be configured on the
--     same branch after an archive.

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS sequence_steps_archived_idx
  ON sequence_steps (sequence_id, archived_at);

-- Archived steps no longer occupy their parent's 'opened' / 'not_opened'
-- branch slot — drop and recreate the partial unique index with the filter.
DROP INDEX IF EXISTS sequence_steps_child_branch_unique;
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_child_branch_unique
  ON sequence_steps (sequence_id, parent_step_id, parent_branch)
  WHERE parent_step_id IS NOT NULL AND archived_at IS NULL;

-- Make PostgREST pick up the new column immediately.
NOTIFY pgrst, 'reload schema';
