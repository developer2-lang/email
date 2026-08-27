-- Email Intelligence — sequence_steps content columns (additive fixup)
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- The remote sequence_steps table was created before the canonical content
-- columns existed: it still has the legacy `subject`/`body` names and lacks
-- the Not-Opened (increment) content columns and the per-step recipient_type.
-- The worker + sequence service read/write normal_subject / normal_body /
-- increment_subject / increment_body / recipient_type exclusively, so without
-- these the save/load and send paths fail.
--
-- Table is empty (steps are added through the UI), so renaming is lossless.
-- All statements are idempotent / guarded so the script can be re-run safely.

-- 1. Legacy content columns -> canonical names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sequence_steps' AND column_name = 'subject'
  ) THEN
    ALTER TABLE sequence_steps RENAME COLUMN subject TO normal_subject;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sequence_steps' AND column_name = 'body'
  ) THEN
    ALTER TABLE sequence_steps RENAME COLUMN body TO normal_body;
  END IF;
END $$;

-- 2. Not-Opened (increment) content columns.
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS increment_subject text,
  ADD COLUMN IF NOT EXISTS increment_body text;

-- 3. Per-step recipient filter (mirrors 20260811110000).
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS recipient_type text NOT NULL DEFAULT 'all';

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_recipient_type_check;
ALTER TABLE sequence_steps
  ADD CONSTRAINT sequence_steps_recipient_type_check
    CHECK (recipient_type IN ('all','opened','not_opened'));

-- Make PostgREST pick up the new columns immediately.
NOTIFY pgrst, 'reload schema';

-- Confirm the final shape.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'sequence_steps'
ORDER BY ordinal_position;
