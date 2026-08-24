-- ============================================================
-- Sequence Automation — Recipient Type + Send Mode (additive)
-- Project: email-intelligence (ref: novreeapdwjnpzflyiey)
-- Applied: 2026-08-11
-- ------------------------------------------------------------
-- What this does:
--   1. sequences        : adds recipient_type (all|opened|not_opened)
--                         and send_mode (automatic|manual|both) with CHECKs.
-- No table is dropped or recreated.
-- ============================================================

-- 1. sequences — recipient filtering + send mode
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS recipient_type text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS send_mode text NOT NULL DEFAULT 'both';

ALTER TABLE sequences
  DROP CONSTRAINT IF EXISTS sequences_recipient_type_check,
  ADD CONSTRAINT sequences_recipient_type_check
    CHECK (recipient_type IN ('all','opened','not_opened'));

ALTER TABLE sequences
  DROP CONSTRAINT IF EXISTS sequences_send_mode_check,
  ADD CONSTRAINT sequences_send_mode_check
    CHECK (send_mode IN ('automatic','manual','both'));
