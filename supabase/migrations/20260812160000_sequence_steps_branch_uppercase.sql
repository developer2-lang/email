-- Email Intelligence — uppercase branch values (additive fixup)
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- sequence_steps.parent_branch is NOT NULL and stores the canonical uppercase
-- branch values: 'STARTING' (root node, parent_step_id IS NULL), 'OPENED' and
-- 'NOT_OPENED' (children). Earlier migrations created the column lowercase and
-- nullable; the worker + service now read/write the uppercase set exclusively.
--
-- Idempotent and safe to re-run: backfills legacy values, then enforces the
-- NOT NULL + CHECK contract.

-- Backfill any legacy lowercase (or missing) values already stored.
UPDATE sequence_steps
SET parent_branch = CASE parent_branch
  WHEN 'opened' THEN 'OPENED'
  WHEN 'not_opened' THEN 'NOT_OPENED'
  WHEN 'STARTING' THEN 'STARTING'
  ELSE 'STARTING'
END;

ALTER TABLE sequence_steps
  ALTER COLUMN parent_branch SET NOT NULL;

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_parent_branch_check;
ALTER TABLE sequence_steps
  ADD CONSTRAINT sequence_steps_parent_branch_check
    CHECK (parent_branch IN ('STARTING','OPENED','NOT_OPENED'));

-- Make PostgREST pick up the constraint change immediately.
NOTIFY pgrst, 'reload schema';

-- Confirm the final shape.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sequence_steps'
ORDER BY ordinal_position;
