-- Campaign follow-up automation.
--
-- 1) campaign_followup_logs records every follow-up triggered by an open.
--      - manual:     a 'pending' row is created; the operator sends it later
--                    from the Pending Follow-ups tab.
--      - automatic:  a row is created and immediately marked 'sent' (or
--                    'failed') when the follow-up campaign is emailed.
--    The UNIQUE constraint on (campaign_id, contact_id, followup_campaign_id)
--    guarantees a recipient only ever receives the same follow-up once.
--
-- 2) campaign_followups (already existing) stores the per-campaign config:
--      followup_campaign_id, trigger_type='opened', followup_mode, is_active.
--    A UNIQUE index on campaign_id keeps one config row per campaign.

CREATE TABLE IF NOT EXISTS campaign_followup_logs (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id          UUID NOT NULL,
  contact_id           UUID NOT NULL,
  email                TEXT NOT NULL,
  followup_campaign_id UUID NOT NULL,
  opened_at            TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending',
  sent_at              TIMESTAMPTZ,
  error_message        TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id, followup_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_followup_logs_status   ON campaign_followup_logs(status);
CREATE INDEX IF NOT EXISTS idx_followup_logs_campaign ON campaign_followup_logs(campaign_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_followups_campaign ON campaign_followups(campaign_id);
