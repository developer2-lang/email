# Sequence Automation — Supabase Serverless Migration

The Sequence system (Sequence Builder + Sequences list + automatic sending +
open/not-opened tracking + branching + dashboard stats) no longer needs the
local Express backend. Everything runs on Supabase:

- React/Vite frontend → Supabase Database (direct anon-key reads/writes,
  same as the rest of the app)
- **SMTP sending** → Supabase Edge Functions (`sequence-runner`,
  `sequence-manual-send`)
- **Open tracking** → Supabase Edge Function (`email-open-tracker`, the 1×1
  pixel inside every sequence email)
- **Automatic scheduling** → Supabase pg_cron (`sequence-runner-setup.sql`)

**The laptop does not need to run `node backend/server.js` or
`node backend/sequenceWorker.js` for sequences to work.** With the functions
deployed and the cron job registered, active sequences keep sending, branching
and tracking 24/7 from the cloud.

---

## 1. What changed

| Piece | Before (local Express) | After (serverless) |
|---|---|---|
| Sequence CRUD, activate/pause, steps, branch steps, audiences, recipients, logs | `GET/POST/PUT/DELETE localhost:5000/api/sequences*` | Direct Supabase queries ported 1:1 into `src/api/sequenceApi.ts` (shapes unchanged — `steps_count`, `steps`, `steps_progress`, `engagement`, `summary`, recipients, manual-send result all preserved) |
| Automatic worker (due enrollments, eligibility, branching, retries) | `node sequenceWorker.js` + `checkDueEnrollments()` | `supabase/functions/sequence-runner/index.ts` — invoked by pg_cron every minute, and fire-and-forget after activation / step creation |
| "Send Now" (manual send) | `POST /api/sequences/:id/manual-send` | `supabase/functions/sequence-manual-send/index.ts` (SMTP + eligibility re-check + step log + tree advance) |
| Open tracking + OPENED-branch advance | Express `handleStepOpened` | `supabase/functions/email-open-tracker/index.ts` (pixel marks `email_logs`, syncs `sequence_step_logs`, advances OPENED child immediately) |
| Dashboard Recent Activity + first-load stats | hardcoded `ACTIVITY_FEED` / only after visiting each tab | `src/services/dashboardService.ts` (real feed from `email_logs`/`sequence_step_logs`/`sequence_enrollments`) + App-mount load of contacts/campaigns/sequences |

**New files**
- `supabase/functions/sequence-runner/index.ts` — automatic worker
- `supabase/functions/sequence-manual-send/index.ts` — "Send Now"
- `supabase/functions/email-open-tracker/index.ts` — open pixel
- `supabase/sequence-runner-setup.sql` — pg_cron scheduler
- `src/api/sequenceApi.ts` — rewritten (Supabase direct + edge invoke)
- `src/services/dashboardService.ts` — real activity feed + enrolled count
- `src/App.tsx` / `src/routes/AppRoutes.tsx` / `src/pages/DashboardTab.tsx` — initial DB load + live feed wiring

**Modified**
- `supabase/config.toml` — `verify_jwt = false` for the three new functions

No schema migrations were added — the existing 11 migrations already define
everything (`sequences`, `sequence_steps`, `sequence_branch_steps`,
`sequence_enrollments`, `sequence_step_logs`, `email_logs`, …). All existing
tables/columns/relationships are preserved.

---

## 2. Deploy commands (run from the project root)

```bash
# 1. Deploy the three new Edge Functions with JWT verification OFF
#    (the app calls them with the anon/publishable key; the cron calls with
#     x-cron-secret; the pixel is loaded by email clients that send no headers).
supabase functions deploy sequence-runner --no-verify-jwt
supabase functions deploy sequence-manual-send --no-verify-jwt
supabase functions deploy email-open-tracker --no-verify-jwt

# 2. Set the shared function secrets (same CRON_SECRET value as step 4)
supabase secrets set \
  CRON_SECRET=<your-random-value> \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=465 \
  SMTP_USER=<you@gmail.com> \
  SMTP_PASSWORD=<google-app-password> \
  SMTP_FROM_NAME="Your Name" \
  SMTP_FROM=<you@gmail.com> \
  SMTP_REPLY_TO=<you@gmail.com>
# Optional tuning (all have safe defaults — omit to keep defaults):
#   EDGE_FUNCTION_URL=https://novreeapdwjnpzflyiey.supabase.co/functions/v1
#   SEQUENCE_OPEN_WINDOW_MS=600000   (default 10 min open-detection window)
#   SEQUENCE_RETRY_DELAY_SECONDS=300 (default; failed sends retried after this)
#   SEQUENCE_CLAIM_LOCK_MS=300000    (idempotency claim lock, default 5 min)
#   (No enrollment batch cap — the runner drains ALL due enrollments per tick,
#    so an "Immediate" step always sends to every eligible recipient.)
#   SEQUENCE_TIME_BUDGET_MS=100000
#   SEQUENCE_SEND_DELAY_MS=1000
```

> Gmail requires an **App Password** (Google Account → Security → 2-Step
> Verification → App passwords). Normal account passwords are rejected by SMTP.

---

## 3. Database / scheduler setup

Run `supabase/sequence-runner-setup.sql` **once** in the Supabase SQL editor
(Dashboard → SQL → New query). It enables `pg_cron`/`pg_net`/`supabase_vault`
(no-ops when present), creates a `sequence-runner` cron job firing every minute
that POSTs to the Edge Function, and verifies the job. Then store the shared
secret in the Vault **with the same value as `CRON_SECRET`**:

```sql
select vault.create_secret('<your-random-value>', 'sequence_cron_secret');
```

If `sequence_cron_secret` ≠ `CRON_SECRET`, the function rejects the cron calls
(logged in `supabase/functions/sequence-runner/index.ts`; visible in the
function's logs).

---

## 4. Frontend

`.env` already has the required values:

```
VITE_SUPABASE_URL=https://novreeapdwjnpzflyiey.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_bzsi4nCSuhxb726_kKcm5Q_Ui0uW1P1
```

`VITE_API_URL` is no longer used by any active code path (`src/api/sequenceApi.ts`
no longer references it). Build/deploy the frontend as usual:

```bash
npm run build
```

---

## 5. Verification steps

### 5.1 Edge functions deployed + auth

1. Open the Supabase Dashboard → **Edge Functions**. Confirm
   `sequence-runner`, `sequence-manual-send`, `email-open-tracker` are present
   with **"JWT verification: OFF"**.
2. In the function logs for `sequence-runner`, run a manual tick and confirm a
   `200 OK`:
   ```sql
   select net.http_post(
     url := 'https://novreeapdwjnpzflyiey.supabase.co/functions/v1/sequence-runner',
     headers := jsonb_build_object(
       'Content-Type','application/json',
       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name='sequence_cron_secret')
     ),
     body := '{}'::jsonb
   ) as request_id;
   -- then: select * from net._http_response order by created desc limit 3;
   ```

### 5.2 Cron job registered

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'sequence-runner';
```
Expect one `* * * * *` active row.

### 5.3 Smoke test — build & activate

1. `npm run build` succeeds.
2. Open the app → **Sequences** → create a sequence (name + audience) → add the
   STARTING step (subject/body, wait 0) → **Activate**. The app invokes
   `sequence-runner` immediately after activation, so Step 1 emails send
   immediately (no need to wait a minute). Verify 6 `sequence_step_logs` rows
   appear (one per eligible contact) and 6 `email_logs` rows are `sent`.
3. Re-run the cron POST manually (5.1). **No new sends** — the
   `UNIQUE (sequence_id, sequence_step_id, contact_id)` idempotency gate holds.

### 5.4 Branch acceptance test (matches the plan)

Tree: Step1 → (OPENED) Step2 / (NOT_OPENED) Step2A; Step2 → Step3/3A;
Step2A → Step4/4A. 6 recipients, wait 0.

1. After Step 1 sends, open one Step-1 email. The `email-open-tracker` pixel
   marks `email_logs.opened` and advances that recipient onto **Step 2
   (OPENED)** immediately (no cron tick needed). `sequence_step_logs` for that
   recipient shows the Step-2 row.
2. For recipients who do **not** open, the runner (after the 10-min open
   window) advances them onto **Step 2A (NOT_OPENED)**.
3. `[BRANCH]` snapshot logs appear in the `sequence-runner` function logs:
   `[BRANCH] STEP … ELIGIBLE/SENT/OPENED/NOT_OPENED`.
4. Run the runner repeatedly → no duplicates, no re-sends, branch totals stay
   correct (opened only ever counts real opens; never classify NOT_OPENED
   before the open window).

### 5.5 Manual send

Sequences page → step → **Send Now** → pick eligible recipients. The
`sequence-manual-send` function re-validates branch eligibility, sends via SMTP,
logs the step, and parks the enrollment for the open window (same behavior as
the worker). Responses match the old `ManualSendResult` shape.

### 5.6 Dashboard reflects real DB state

Dashboard shows total contacts / active sequences / contacts enrolled from
Supabase on first load, and Recent Activity lists real sends/opens/enrollments
from `email_logs` + `sequence_step_logs` (falling back to the placeholder feed
only when the DB is empty).

---

## 6. Local backend no longer required

- `src/api/sequenceApi.ts` no longer contains any `fetch(VITE_API_URL…)`.
- `src/api/campaignApi.ts` (the other `localhost:5000` client) is dead code —
  not imported anywhere.
- `node backend/server.js` and `node backend/sequenceWorker.js` can remain in
  the repo for reference but are **not** required to run the product.

Sequence automation runs entirely on Supabase: pg_cron → `sequence-runner` →
Gmail SMTP, with `email-open-tracker`/`click-tracker` handling engagement and
branching — all reachable with the laptop OFF.