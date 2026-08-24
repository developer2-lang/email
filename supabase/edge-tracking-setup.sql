-- Edge tracking (test-only) setup.
-- Additive only — it does NOT touch the legacy open/click tracking columns
-- (email_logs.tracking_id/opened/clicked, campaign_analytics) at all.
--
-- The campaign-tracker Edge Function writes contacts.email_opened when the
-- edge tracking pixel fires. Run this in the Supabase SQL editor before using
-- TRACKING_MODE=edge.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_opened BOOLEAN NOT NULL DEFAULT false;

-- Confirm the column exists.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'contacts' AND column_name = 'email_opened';
