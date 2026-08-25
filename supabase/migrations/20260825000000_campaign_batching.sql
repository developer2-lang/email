-- ============================================================================
-- Campaign batch / throttled sending
-- ============================================================================
-- Adds controlled batch sending to campaigns WITHOUT changing the existing
-- send behaviour: batch_enabled defaults to false, so every existing campaign
-- keeps sending all eligible recipients exactly as before.
--
-- Run this ONCE in the Supabase SQL editor (Dashboard -> SQL -> New query), or
-- place it in supabase/migrations and let `supabase db push` apply it.
--
-- Columns added to public.campaigns:
--   batch_enabled            boolean  default false  -- master switch
--   batch_size               integer  default 30     -- recipients per batch
--   batch_interval_minutes   integer  default 60     -- gap between batches
--   current_batch_number     integer  default 0      -- last batch sent (counter)
--   total_batches            integer  default null   -- estimated total (ceil)
--   next_batch_at            timestamptz default null -- when the next batch fires
--
-- email_logs.batch_number lets a worker record WHICH batch a recipient belonged
-- to. Recipients are still exactly one email_log row per contact_id, so a contact
-- can never be mailed twice across batches (the batch claim only ever selects
-- rows still in 'pending').
-- ============================================================================

alter table if exists public.campaigns
  add column if not exists batch_enabled boolean not null default false,
  add column if not exists batch_size integer not null default 30,
  add column if not exists batch_interval_minutes integer not null default 60,
  add column if not exists current_batch_number integer not null default 0,
  add column if not exists total_batches integer,
  add column if not exists next_batch_at timestamp with time zone;

alter table if exists public.email_logs
  add column if not exists batch_number integer;
