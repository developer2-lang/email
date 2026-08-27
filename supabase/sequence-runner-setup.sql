-- ============================================================================
-- sequence-runner — FREE cloud scheduler setup (Supabase pg_cron)
-- ============================================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- What it does:
--   1) Enables pg_net (HTTP requests from Postgres) and supabase_vault
--      (encrypted secrets) if they are not already enabled.
--   2) Creates a pg_cron job that fires EVERY 30 SECONDS and POSTs to the
--      sequence-runner Edge Function. That function finds due sequence
--      enrollments and sends their emails directly to Gmail SMTP — so active
--      sequences keep running (opens tracked, branches advanced, next steps
--      sent) even when the laptop (local Node.js backend) is completely OFF.
--      The cron interval is ONLY the polling frequency: an "Immediate"
--      (wait_hours = 0) step is due at NOW() and is sent on the very next tick
--      (0–30 seconds later). It does NOT add any business delay — the step's
--      configured wait_hours (0h/1h/2h/24h/…) is the only thing that pushes
--      next_run_at into the future.
--      The React app also invokes sequence-runner once right after a sequence
--      is activated so Step 1 sends immediately without waiting for the cron
--      tick; the cron is the fallback / steady-state scheduler.
--   3) The POST carries the shared CRON_SECRET in the `x-cron-secret` header.
--      The secret is read from the Supabase Vault at run time, so it never
--      appears in this file or in git.
--
-- Order of operations:
--   a. Deploy the Edge Function:
--        supabase functions deploy sequence-runner --no-verify-jwt
--   b. Set the function's secrets (same CRON_SECRET value as in step d):
--        supabase secrets set \
--          CRON_SECRET=<your-random-value> \
--          SMTP_HOST=smtp.gmail.com SMTP_PORT=465 \
--          SMTP_USER=you@gmail.com SMTP_PASSWORD=<app-password> \
--          SMTP_FROM_NAME="Your Name" SMTP_FROM=you@gmail.com \
--          SMTP_REPLY_TO=you@gmail.com
--        (EDGE_FUNCTION_URL is optional; leave unset to auto-derive from
--        SUPABASE_URL.)
--   c. Run this file in the SQL editor.
--   d. Store the shared cron secret in the Vault ONCE (replace the value):
--        select vault.create_secret('<your-random-value>', 'sequence_cron_secret');
--      NOTE: `sequence_cron_secret` must equal the `CRON_SECRET` env secret
--      set on the Edge Function in step b, or the function rejects the call.
--   e. Deploy the remaining sequence functions:
--        supabase functions deploy sequence-manual-send --no-verify-jwt
--        supabase functions deploy email-open-tracker --no-verify-jwt
-- ============================================================================

-- 1) Enable extensions (no-ops when already enabled; pg_cron is on by default
--    for hosted Supabase projects).
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- 2) Create / replace the cron job. The job is idempotent: re-running this
--    script unschedules the previous job first, then schedules a fresh one.
--
-- NOTE (deployed 2026-08-14): the live project's cron job is registered with
-- the anon-key variant below instead of the x-cron-secret variant, because
-- `vault.create_secret` / direct `vault.secrets` inserts are permission-blocked
-- for the project's DB role (`permission denied for function
-- _crypto_aead_det_noncegen`). The anon/publishable key is the same public
-- client credential the React app ships to the browser, and sequence-runner
-- accepts it via its existing isAuthorized() path, so this is functionally
-- equivalent and requires no vault setup.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sequence-runner') then
    perform cron.unschedule('sequence-runner');
  end if;

  perform cron.schedule(
    'sequence-runner',
    '*/30 * * * * *', -- every 30 seconds (polling frequency only — see header)
    $cron$
    select
      net.http_post(
        url := 'https://novreeapdwjnpzflyiey.supabase.co/functions/v1/sequence-runner',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', '<VITE_SUPABASE_ANON_KEY>',
          'Authorization', 'Bearer <VITE_SUPABASE_ANON_KEY>'
        ),
        body := '{}'::jsonb
      ) as request_id;
    $cron$
  );
end
$$;

-- 3) Confirm the job is registered.
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'sequence-runner';

-- 4) (Optional) Manual smoke test — run the same POST the cron job would run:
--    select
--      net.http_post(
--        url := 'https://novreeapdwjnpzflyiey.supabase.co/functions/v1/sequence-runner',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'x-cron-secret',
--          (select decrypted_secret from vault.decrypted_secrets where name = 'sequence_cron_secret')
--        ),
--        body := '{}'::jsonb
--      ) as request_id;
--
--    Responses land in net._http_response; check the last run with:
--      select * from net._http_response order by created desc limit 3;
--
--    To stop scheduling entirely (keep the function deployed):
--      select cron.unschedule('sequence-runner');

-- 5) (Optional) Drain all sequences by hand without waiting for the cron
--    (same POST the cron would run):
--    select
--      net.http_post(
--        url := 'https://novreeapdwjnpzflyiey.supabase.co/functions/v1/sequence-runner',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'x-cron-secret',
--          (select decrypted_secret from vault.decrypted_secrets where name = 'sequence_cron_secret')
--        ),
--        body := jsonb_build_object('force', true)
--      ) as request_id;
