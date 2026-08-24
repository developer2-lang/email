-- ============================================================================
-- Email Intelligence — Open / Click tracking migration (canonical)
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Safe to re-run: every statement is idempotent (ADD COLUMN IF NOT EXISTS,
-- CREATE UNIQUE INDEX IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION).
--
-- What it does:
--   1) Adds open/click/tracking columns to email_logs.
--   2) Creates the campaign_analytics table (one row per campaign).
--   3) Recreates record_email_open / record_email_click so they:
--        - mark the email_log row (opened/clicked + timestamp), once only
--        - upsert campaign_analytics (increment opened/clicked, recompute
--          open_rate / click_rate from delivered count)
--   4) Backfills campaign_analytics for every campaign from email_logs.
-- ============================================================================

-- 1) email_logs — tracking columns.
ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS opened       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clicked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_id  UUID;

-- Backfill tracking ids for rows created before this migration.
UPDATE email_logs SET tracking_id = gen_random_uuid() WHERE tracking_id IS NULL;

-- Enforce uniqueness + non-null now that every row has a tracking id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_logs_tracking_id ON email_logs (tracking_id);
ALTER TABLE email_logs ALTER COLUMN tracking_id SET NOT NULL;

-- 2) campaign_analytics — one row per campaign, the source of truth the
--    frontend displays (opened, clicked, open_rate, click_rate).
--
-- IMPORTANT: if a read-only analytics VIEW with this name already exists
-- (common — a "campaign_analytics" view is easy to create before this
-- migration is run), the CREATE TABLE below would silently no-op and every
-- backend write (worker sync, tracking RPCs) would fail with PostgREST error
-- 55000 "cannot update view". Drop the stale view first so the writable TABLE
-- is actually created.
DROP VIEW IF EXISTS campaign_analytics;
CREATE TABLE IF NOT EXISTS campaign_analytics (
  campaign_id      UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  delivered        INTEGER NOT NULL DEFAULT 0,
  opened           INTEGER NOT NULL DEFAULT 0,
  clicked          INTEGER NOT NULL DEFAULT 0,
  open_rate        NUMERIC(5,1) NOT NULL DEFAULT 0,
  click_rate       NUMERIC(5,1) NOT NULL DEFAULT 0
);

-- 3) RPC functions used by the backend tracking endpoints
--    (GET /api/tracking/open/:trackingId, GET /api/tracking/click/:trackingId).
--    Idempotent: repeated pixel loads / link clicks only record once.
CREATE OR REPLACE FUNCTION public.record_email_open(p_tracking_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  -- NOTE: no sent_at grace filter here. Gmail's image proxy / Outlook prefetch
  -- request each pixel URL exactly ONCE seconds after delivery and then serve
  -- the cached image to the human later, so that first request is the only
  -- chance to record the open. Counting the prefetch as an open is the
  -- industry standard (every ESP does it). A grace filter would silently lose
  -- every Gmail/Outlook open.

  UPDATE email_logs
  SET opened = true, opened_at = NOW()
  WHERE id = v_log.id AND opened = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate open: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 1, 0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END,
    0
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    opened           = campaign_analytics.opened + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    open_rate        = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.opened + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_email_click(p_tracking_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  UPDATE email_logs
  SET clicked = true, clicked_at = NOW()
  WHERE id = v_log.id AND clicked = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate click: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 0, 1,
    0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    clicked          = campaign_analytics.clicked + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    click_rate       = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.clicked + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;

-- 4) Backfill: rebuild campaign_analytics for every campaign from email_logs.
--    Safe to re-run any time (this is what the backend's worker also does).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT campaign_id, COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'sent') AS delivered,
           COUNT(*) FILTER (WHERE opened = true)  AS opened,
           COUNT(*) FILTER (WHERE clicked = true) AS clicked
    FROM email_logs
    GROUP BY campaign_id
  LOOP
    INSERT INTO campaign_analytics
      (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
    VALUES (
      r.campaign_id, r.total, r.delivered, r.opened, r.clicked,
      CASE WHEN r.delivered > 0 THEN ROUND((r.opened::numeric / r.delivered) * 100, 1) ELSE 0 END,
      CASE WHEN r.delivered > 0 THEN ROUND((r.clicked::numeric / r.delivered) * 100, 1) ELSE 0 END
    )
    ON CONFLICT (campaign_id) DO UPDATE SET
      total_recipients = EXCLUDED.total_recipients,
      delivered        = EXCLUDED.delivered,
      opened           = EXCLUDED.opened,
      clicked          = EXCLUDED.clicked,
      open_rate        = EXCLUDED.open_rate,
      click_rate       = EXCLUDED.click_rate;
  END LOOP;
END;
$$;

-- Grants so the backend (service_role) and any other caller can invoke.
GRANT EXECUTE ON FUNCTION public.record_email_open(UUID)  TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_email_click(UUID) TO service_role, anon, authenticated;

-- 5) Confirm the final shapes.
SELECT 'email_logs' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'email_logs'
ORDER BY ordinal_position;

SELECT 'campaign_analytics' AS tbl, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'campaign_analytics'
ORDER BY ordinal_position;

SELECT * FROM campaign_analytics ORDER BY delivered DESC;
