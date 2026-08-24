-- Email Intelligence — campaign workflow migration
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Adds the columns the backend campaign workflow needs to persist
-- audit timestamps on the `campaigns` table, plus the columns and
-- constraints the send worker depends on in `email_logs` and
-- `campaign_contacts`.

-- 1) `campaigns` — Mailchimp metadata and audit timestamps.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS html_content          TEXT,
  ADD COLUMN IF NOT EXISTS mailchimp_campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS recipient_count       INTEGER,
  ADD COLUMN IF NOT EXISTS sent_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_at          TIMESTAMPTZ;

-- 2) `email_logs` — columns required by the worker's retry logic.
--    Without these, the worker fails with "column email_logs.next_retry_at
--    does not exist" (error 42703) and the campaign flips to `failed`.
ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ;

-- 3) `campaign_contacts` — composite primary key so the worker can upsert
--    links safely. Without it, "Send Now" fails with error 42P10
--    ("no unique or exclusion constraint matching the ON CONFLICT
--    specification"). ADD CONSTRAINT has no IF NOT EXISTS, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_contacts_pkey'
  ) THEN
    ALTER TABLE campaign_contacts
      ADD CONSTRAINT campaign_contacts_pkey PRIMARY KEY (campaign_id, contact_id);
  END IF;
END $$;

-- Confirm the final shapes.
SELECT 'email_logs' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'email_logs'
ORDER BY ordinal_position;

SELECT 'campaign_contacts' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'campaign_contacts'
ORDER BY ordinal_position;
