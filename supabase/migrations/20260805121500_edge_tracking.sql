-- Edge open-tracking (test-only) setup.
-- Additive only — does NOT touch the legacy tracking columns
-- (email_logs.tracking_id/opened/clicked, campaign_analytics).

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_opened BOOLEAN NOT NULL DEFAULT false;
