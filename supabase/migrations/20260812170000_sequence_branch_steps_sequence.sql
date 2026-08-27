-- Scope sequence_branch_steps per sequence and add the Wait Hours column.
--
-- sequence_branch_steps previously held a single GLOBAL tree keyed only by
-- (step, parent_branch). This migration adds sequence_id so each sequence has
-- its own branch rows (the edit form's mirror now writes sequence_id), plus
-- wait_hours for the new "Wait Hours" column.
--
-- sequence_id is left nullable so pre-existing rows can be backfilled to their
-- correct sequence before the app re-saves; the application always sets it.
ALTER TABLE sequence_branch_steps
  ADD COLUMN IF NOT EXISTS sequence_id uuid,
  ADD COLUMN IF NOT EXISTS wait_hours integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sequence_branch_steps_sequence_idx
  ON sequence_branch_steps (sequence_id);
