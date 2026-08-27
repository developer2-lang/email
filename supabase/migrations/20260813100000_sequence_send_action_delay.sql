-- Email Intelligence — per-step auto-send configuration (additive, safe ALTERs)
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Adds a "Send Action" + "Send After" delay to every sequence step:
--   send_action       text    NOT NULL default 'send_automatically'
--                            'send_email' | 'send_automatically' | 'skip'
--   send_after_value  integer            length of the delay (e.g. 2)
--   send_after_unit   text               'minutes' | 'hours' | 'days'
--
-- Backward compatible: when send_after_value/send_after_unit are NULL the
-- worker falls back to the legacy wait_hours, so existing steps keep their
-- exact scheduling. All statements are idempotent / guarded.

-- 1. sequence_steps — the canonical step table.
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS send_action text NOT NULL DEFAULT 'send_automatically',
  ADD COLUMN IF NOT EXISTS send_after_value integer,
  ADD COLUMN IF NOT EXISTS send_after_unit text;

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_send_action_check;
ALTER TABLE sequence_steps
  ADD CONSTRAINT sequence_steps_send_action_check
    CHECK (send_action IN ('send_email','send_automatically','skip'));

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_send_after_unit_check;
ALTER TABLE sequence_steps
  ADD CONSTRAINT sequence_steps_send_after_unit_check
    CHECK (send_after_unit IS NULL OR send_after_unit IN ('minutes','hours','days'));

-- 2. sequence_branch_steps — the flat edit-form mirror, kept in sync by the service.
ALTER TABLE sequence_branch_steps
  ADD COLUMN IF NOT EXISTS send_action text NOT NULL DEFAULT 'send_automatically',
  ADD COLUMN IF NOT EXISTS send_after_value integer,
  ADD COLUMN IF NOT EXISTS send_after_unit text;

ALTER TABLE sequence_branch_steps
  DROP CONSTRAINT IF EXISTS sequence_branch_steps_send_action_check;
ALTER TABLE sequence_branch_steps
  ADD CONSTRAINT sequence_branch_steps_send_action_check
    CHECK (send_action IN ('send_email','send_automatically','skip'));

ALTER TABLE sequence_branch_steps
  DROP CONSTRAINT IF EXISTS sequence_branch_steps_send_after_unit_check;
ALTER TABLE sequence_branch_steps
  ADD CONSTRAINT sequence_branch_steps_send_after_unit_check
    CHECK (send_after_unit IS NULL OR send_after_unit IN ('minutes','hours','days'));

-- Make PostgREST pick up the new columns immediately.
NOTIFY pgrst, 'reload schema';

-- Confirm the final shape.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'sequence_steps'
ORDER BY ordinal_position;