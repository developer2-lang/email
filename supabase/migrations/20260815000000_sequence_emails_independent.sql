-- ============================================================
-- Sequence emails independent from Campaigns (additive)
-- Project: email-intelligence (ref: novreeapdwjnpzflyiey)
-- ------------------------------------------------------------
-- Sequence emails are now tracked purely through the Sequence
-- tables (sequence_enrollments, sequence_step_logs) plus their
-- `email_logs` rows, which carry a NULL campaign_id. Sequence
-- flows no longer create a dedicated hidden `campaigns` row
-- (campaign_type = 'sequence').
--
-- This migration only relaxes the NOT NULL constraint on
-- email_logs.campaign_id so sequence email_logs can exist without
-- a campaign. Real campaign sends are UNCHANGED: they still write
-- their own campaign_id. Idempotent / safe to re-run.
-- ============================================================

ALTER TABLE email_logs
  ALTER COLUMN campaign_id DROP NOT NULL;