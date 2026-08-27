-- ============================================================
-- Sequence Automation — dedicated campaign per sequence (additive)
-- Project: email-intelligence (ref: novreeapdwjnpzflyiey)
-- ------------------------------------------------------------
-- Sequence step emails are logged in `email_logs`, whose
-- `campaign_id` has a NOT NULL FK to `campaigns.id`. Using the
-- sequence's `starting_campaign_id` pollutes the starting
-- campaign's analytics / opened-contacts / follow-up logic.
-- This migration adds an optional `sequences.campaign_id` that the
-- sequence worker lazily populates with a dedicated hidden
-- campaign (campaign_type = 'sequence') so sequence email_logs are
-- fully isolated.
-- No table is dropped or recreated.
-- ============================================================

ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sequences_campaign_id_idx ON sequences (campaign_id);
