-- Email Intelligence — sequence recursive branch-tree migration
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Turns sequence_steps into a recursive email branching workflow with NO
-- Starting Campaign: the sequence itself sends Step 1 to every enrolled
-- recipient, then every subsequent step branches OPENED / NOT OPENED off the
-- most recently sent email on that recipient's own branch.
--
-- Each step row is a NODE in the branch tree (parent_step_id is the exact
-- parent row, NOT a number):
--
--   parent_step_id uuid -> the exact parent step row this node extends
--                          (null = the starting step).
--   parent_branch text  -> which path of the parent this node belongs to:
--                          'opened' | 'not_opened'.
--
--   Step 1            : parent_step_id = NULL  (the starting step).
--   Step 2            : two nodes — Step 2 Opened (parent=Step 1,
--                        parent_branch='opened') and Step 2 Not Opened
--                        (parent=Step 1, parent_branch='not_opened').
--   Step 3            : four nodes (Step 2 Opened × opened/not_opened,
--                        Step 2 Not Opened × opened/not_opened), etc.
--
-- Uniqueness therefore moves from (sequence_id, step_number) to
-- (sequence_id, parent_step_id, parent_branch): each parent node may have at
-- most ONE 'opened' child and ONE 'not_opened' child. `step_number` becomes a
-- display depth shared by sibling nodes (Step 2 has two rows at number 2, etc.)
-- and is no longer unique.

ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS parent_step_id uuid REFERENCES sequence_steps(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS parent_branch text CHECK (parent_branch IN ('opened','not_opened'));

-- ─── Backfill from the previous parent-path model ─────────────────────────
-- Old columns: parent_path = the PARENT'S STEP NUMBER (text), branch_type =
-- the path. Map them onto the exact parent row so existing sequences keep
-- working and get the recursive tree for free.
UPDATE sequence_steps child
SET parent_step_id = parent.id,
    parent_branch  = COALESCE(child.parent_branch, child.branch_type)
FROM sequence_steps parent
WHERE child.sequence_id = parent.sequence_id
  AND child.parent_step_id IS NULL
  AND child.parent_path IS NOT NULL
  AND parent.step_number = child.parent_path::integer;

-- ─── Uniqueness / indexes ─────────────────────────────────────────────────
-- step_number is now a shared display depth — drop ANY unique constraint/index
-- that still enforces one row per (sequence_id, step_number). A unique index
-- backing a constraint cannot be dropped directly, so drop the constraint
-- first (that removes its backing index) and then any standalone unique index.
DO $$
DECLARE _idx text;
        _con text;
BEGIN
  FOR _con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'sequence_steps'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%step_number%'
  LOOP
    EXECUTE format('ALTER TABLE sequence_steps DROP CONSTRAINT %I', _con);
  END LOOP;
  FOR _idx IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'sequence_steps'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%step_number%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', _idx);
  END LOOP;
END $$;

-- Old uniqueness by (sequence_id, parent_path, branch_type) blocks two
-- children with the same parent step-number on the same path — superseded by
-- the exact-row uniqueness below.
DROP INDEX IF EXISTS sequence_steps_branch_unique;

-- One 'opened' child + one 'not_opened' child per parent node.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_child_branch_unique
  ON sequence_steps (sequence_id, parent_step_id, parent_branch)
  WHERE parent_step_id IS NOT NULL;

-- Fast child lookup on every branch advance + engagement read.
DROP INDEX IF EXISTS sequence_steps_parent_lookup_idx;
CREATE INDEX IF NOT EXISTS sequence_steps_parent_step_idx
  ON sequence_steps (sequence_id, parent_step_id);
CREATE INDEX IF NOT EXISTS sequence_steps_step_number_idx
  ON sequence_steps (sequence_id, step_number);

-- ─── Enrollments track the exact node ─────────────────────────────────────
-- current_step is now only a display depth; current_step_id is the source of
-- truth (multiple rows share a step_number, so a number alone is ambiguous).
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS current_step_id uuid REFERENCES sequence_steps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sequence_enrollments_current_step_id_idx
  ON sequence_enrollments (current_step_id);

-- Make PostgREST pick up the new columns immediately (fixes
-- "Could not find the 'parent_step_id' column of 'sequence_steps' in the schema cache").
NOTIFY pgrst, 'reload schema';

-- Confirm the final shape.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sequence_steps'
ORDER BY ordinal_position;
