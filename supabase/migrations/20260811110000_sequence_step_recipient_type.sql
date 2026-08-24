-- ============================================================
-- Sequence Automation — Per-Step Recipient Type (additive)
-- Project: email-intelligence (ref: novreeapdwjnpzflyiey)
-- Applied: 2026-08-11
-- ------------------------------------------------------------
-- What this does:
--   1. sequence_steps  : adds recipient_type (all|opened|not_opened)
--                        so each step can independently filter who
--                        receives it, evaluated from tracking data at
--                        send time.
--   2. sequences.recipient_type (added earlier) is kept for backwards
--      compatibility; the canonical per-step filter lives here.
-- No table is dropped or recreated.
-- ============================================================

-- 1. sequence_steps — per-step recipient filter
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS recipient_type text NOT NULL DEFAULT 'all';

ALTER TABLE sequence_steps
  DROP CONSTRAINT IF EXISTS sequence_steps_recipient_type_check,
  ADD CONSTRAINT sequence_steps_recipient_type_check
    CHECK (recipient_type IN ('all','opened','not_opened'));
