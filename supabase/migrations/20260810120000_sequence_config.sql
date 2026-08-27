-- ============================================================
-- Sequence Automation — schema migration (additive, safe ALTERs)
-- Project: email-intelligence (ref: novreeapdwjnpzflyiey)
-- Applied: 2026-08-10
-- ------------------------------------------------------------
-- What this does:
--   1. Cleans up leftover schema-probe test rows.
--   2. sequences        : adds starting_campaign_id (FK campaigns),
--                         audience_segment, trigger_type + status CHECK.
--   3. sequence_steps   : renames subject/body -> normal_subject/normal_body
--                         to match the canonical step structure.
--   4. sequence_enrollments: adds enrolled_at, last_action_at
--                         (canonical contact state table).
--   5. sequence_step_logs: adds UNIQUE(sequence_id, sequence_step_id, contact_id)
--                         for send idempotency.
--   6. Indexes for the worker lookups.
-- No table is dropped or recreated.
-- ============================================================

-- 1. Remove leftover probe/test rows (no production impact).
DELETE FROM sequence_steps
WHERE sequence_id = '3af7f959-4d8d-4fae-8905-ad4c89b8c8bd'
   OR id = '8850c938-1608-4c21-aa8f-9e2e8c6b41fc';

DELETE FROM sequences
WHERE id = '3af7f959-4d8d-4fae-8905-ad4c89b8c8bd'
   OR name = '__schema_probe__';

-- 2. sequences — config columns
ALTER TABLE sequences
  ADD COLUMN IF NOT EXISTS starting_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS audience_segment text,
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'behaviour';

-- 3. sequence_steps — canonical step body column names
ALTER TABLE sequence_steps RENAME COLUMN subject TO normal_subject;
ALTER TABLE sequence_steps RENAME COLUMN body TO normal_body;

-- 4. sequence_enrollments — canonical contact-state timestamps
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS enrolled_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_action_at timestamptz;

-- 5. sequence_step_logs — idempotency (never log the same step/contact twice)
ALTER TABLE sequence_step_logs
  ADD CONSTRAINT sequence_step_logs_seq_step_contact_key
  UNIQUE (sequence_id, sequence_step_id, contact_id);

-- 6. Appropriate CHECK constraints (tables are empty, so safe)
ALTER TABLE sequences
  DROP CONSTRAINT IF EXISTS sequences_status_check,
  ADD CONSTRAINT sequences_status_check CHECK (status IN ('draft','active','paused','completed'));

ALTER TABLE sequences
  DROP CONSTRAINT IF EXISTS sequences_trigger_type_check,
  ADD CONSTRAINT sequences_trigger_type_check CHECK (trigger_type IN ('manual','time_based','behaviour'));

ALTER TABLE sequence_enrollments
  DROP CONSTRAINT IF EXISTS sequence_enrollments_current_email_type_check,
  ADD CONSTRAINT sequence_enrollments_current_email_type_check CHECK (current_email_type IN ('normal','increment'));

-- 7. Indexes for worker lookups + FK scans
CREATE INDEX IF NOT EXISTS sequences_starting_campaign_id_idx ON sequences (starting_campaign_id);
CREATE INDEX IF NOT EXISTS sequence_enrollments_next_run_at_idx ON sequence_enrollments (next_run_at);
CREATE INDEX IF NOT EXISTS sequence_enrollments_status_idx ON sequence_enrollments (status);
CREATE INDEX IF NOT EXISTS sequence_step_logs_email_log_id_idx ON sequence_step_logs (email_log_id);
