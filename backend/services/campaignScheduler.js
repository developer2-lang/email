/**
 * Campaign scheduler.
 *
 * Every minute it looks for campaigns that are scheduled and due. A campaign is
 * "due" when ANY of its scheduled instants has arrived (see isCampaignDue in
 * utils/scheduleTime.js):
 *   - the legacy IST wall-clock (schedule_date + schedule_time), which the UI
 *     writes for one-off scheduled sends,
 *   - campaigns.scheduled_at (absolute timestamptz),
 *   - a one_time row in campaign_schedules (start_date + send_time),
 *   - a recurring (weekly/monthly) schedule whose next_run has arrived.
 *
 * Overdue campaigns (whose time passed while the backend was off) are picked up
 * on the very next tick, and recurring campaigns that live only in
 * campaign_schedules are no longer invisible to this scheduler.
 *
 * The frontend stores schedule_date as "YYYY-MM-DD" and schedule_time in IST
 * (either 24-hour "14:21:00" / "10:00:00" or 12-hour "10:00 AM"). Both formats
 * are parsed in utils/scheduleTime.js and converted to the absolute UTC instant
 * they represent, so the due-check never depends on the local timezone of the
 * server.
 *
 * For every due campaign the scheduler delegates to the email worker
 * (processCampaign), which: marks the campaign "sending" → resolves the
 * audience contacts → creates any missing email_logs → sends to every
 * recipient (with per-recipient retries) → marks the campaign "sent".
 * A fatal failure marks the campaign "failed" so it never stays stuck in
 * "scheduled". A campaign with zero deliverable recipients is also marked
 * "failed" (with a logged reason) instead of being falsely reported "sent".
 *
 * CLOUD COEXISTENCE (Supabase pg_cron → scheduled-campaign-runner Edge
 * Function): this local scheduler and the cloud scheduler can both be running.
 * To guarantee a due campaign is sent exactly once, each campaign is ATOMICALLY
 * CLAIMED first (UPDATE campaigns SET status='sending' WHERE status='scheduled'
 * — single SQL, one winner). If the claim returns no row, the campaign is
 * already owned by the other runner (or was already sent) and this tick skips
 * it. While the local worker sends, a heartbeat bumps campaigns.updated_at so
 * the cloud's >10 min "stuck in sending" recovery never reclaims a campaign a
 * live process is legitimately working on.
 */
import { processCampaign } from '../workers/emailWorker.js';
import * as supabaseService from '../services/supabaseService.js';
import { parseTime, istDateTimeToUtc, computeNextRun, isCampaignDue } from '../utils/scheduleTime.js';

const CHECK_INTERVAL_MS = 60 * 1000; // check once per minute

let _timer = null;
let _checking = false;

/**
 * Fetch campaigns that are scheduled AND whose scheduled instant has passed.
 *
 * Discovery is intentionally inclusive: every campaign with status 'scheduled'
 * is examined (along with its campaign_schedules row) and considered due when
 * ANY of these is <= now:
 *   - the legacy IST wall-clock (schedule_date + schedule_time),
 *   - campaigns.scheduled_at (absolute instant),
 *   - a one_time campaign_schedules row (start_date + send_time),
 *   - a recurring (weekly/monthly) schedule whose next_run has arrived.
 *
 * This means overdue campaigns (whose time passed while the machine/backend
 * was off) are picked up immediately on the very next tick, and recurring
 * campaigns that live only in campaign_schedules are no longer invisible.
 *
 * @returns {Promise<Array<object>>}
 */
async function getDueCampaigns() {
  const { data, error } = await supabaseService.supabase
    .from('campaigns')
    .select('*, campaign_schedules(*)')
    .eq('status', 'scheduled');

  if (error) throw error;

  const now = Date.now();
  const due = [];
  for (const campaign of data || []) {
    const schedules = (campaign.campaign_schedules || [])
      .filter((s) => s && s.is_active !== false);
    const schedule = schedules.length > 0 ? schedules[0] : null;
    if (isCampaignDue(campaign, schedule, now)) {
      due.push(campaign);
    }
  }
  return due;
}

/**
 * Atomically claim a due campaign for sending. Only ONE runner (this local
 * scheduler or the cloud Edge Function) can transition 'scheduled' → 'sending'
 * for a given campaign, so concurrent ticks can never double-send it.
 *
 * @param {string} campaignId
 * @returns {Promise<boolean>} true if this runner won the claim
 */
async function claimCampaignForSending(campaignId) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseService.supabase
    .from('campaigns')
    .update({ status: 'sending', updated_at: nowIso })
    .eq('id', campaignId)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

/**
 * Process a single due scheduled campaign by delegating to the email worker.
 *
 * Claims the campaign atomically first (so the cloud scheduler cannot send it
 * too), then keeps a heartbeat running on campaigns.updated_at while the
 * worker is sending — that prevents the cloud scheduler's stuck-campaign
 * recovery (>10 min in "sending") from reclaiming a live send.
 *
 * @param {object} campaign
 * @returns {Promise<{sent: number, failed: number, total: number, skipped: boolean}>}
 */
async function processScheduledCampaign(campaign) {
  const claimed = await claimCampaignForSending(campaign.id);
  if (!claimed) {
    console.log(
      `[Scheduler] Campaign ${campaign.id} ("${campaign.campaign_name}") is already claimed ` +
      '(being sent by the other scheduler or already sent) — skipping'
    );
    return { sent: 0, failed: 0, total: 0, skipped: true };
  }

  const label = `${campaign.schedule_date || '?'} ${campaign.schedule_time || '?'} (IST)`;
  console.log(`[Scheduler] Processing campaign ${campaign.id} ("${campaign.campaign_name}")`);
  console.log(`[Scheduler] Scheduled for ${label} — now due, sending...`);
  console.log(`[Scheduler] Sending campaign ${campaign.id} ...`);

  // Heartbeat: keep campaigns.updated_at fresh every minute while the worker
  // sends, so the cloud scheduler's stuck-recovery (RECLAIM_AFTER_MS = 10 min)
  // never reclaims this campaign mid-send.
  const heartbeat = setInterval(() => {
    supabaseService.supabase
      .from('campaigns')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', campaign.id)
      .then(() => {})
      .catch((error) => {
        console.error(`[Scheduler] Heartbeat failed for campaign ${campaign.id}: ${error.message}`);
      });
  }, 60 * 1000);

  try {
    const result = await processCampaign(campaign.id);

    console.log(
      `[Scheduler] Campaign completed — ${result.sent} sent, ${result.failed} failed, ` +
      `${result.total} total`
    );

    // Recurring advance: when the campaign has an active weekly/monthly
    // schedule and a next occurrence exists, return it to "scheduled" with
    // next_run advanced instead of leaving it "sent". The worker already
    // delivered this occurrence; keeping it "scheduled" lets the scheduler
    // (local or cloud) pick it up again at the next occurrence. One-time and
    // exhausted schedules stay "sent".
    const schedules = (campaign.campaign_schedules || [])
      .filter((s) => s && s.is_active !== false);
    const schedule = schedules.length > 0 ? schedules[0] : null;
    if (
      schedule &&
      (schedule.schedule_type === 'weekly' || schedule.schedule_type === 'monthly')
    ) {
      const next = computeNextRun(schedule);
      if (next) {
        await supabaseService.supabase
          .from('campaign_schedules')
          .update({ next_run: next.toISOString(), last_run: new Date().toISOString() })
          .eq('campaign_id', campaign.id);
        await supabaseService.supabase
          .from('campaigns')
          .update({ status: 'scheduled', updated_at: new Date().toISOString() })
          .eq('id', campaign.id);
        console.log(
          `[Scheduler] Recurring campaign ${campaign.id} advanced to next run ` +
          `${next.toISOString()} — kept "scheduled"`
        );
      }
    }
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * One full scheduler tick: find due campaigns and process each one.
 * Guarded so concurrent ticks never overlap.
 */
async function checkScheduledCampaigns() {
  if (_checking) return;
  _checking = true;
  try {
    console.log('[Scheduler] Checking scheduled campaigns...');
    const due = await getDueCampaigns();
    console.log(`[Scheduler] Found ${due.length} campaign${due.length === 1 ? '' : 's'}`);

    for (const campaign of due) {
      try {
        await processScheduledCampaign(campaign);
      } catch (error) {
        console.error(`[Scheduler] Failed to process campaign ${campaign.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[Scheduler] Error while checking scheduled campaigns: ${error.message}`);
  } finally {
    _checking = false;
  }
}

/**
 * Start the scheduler. Runs one immediate check (so any campaign whose time
 * has already passed is picked up right after a backend restart) and then
 * checks once per minute.
 */
function startCampaignScheduler() {
  if (_timer) return;
  console.log('[Scheduler] Started');
  console.log('[Scheduler] Checking every 60 seconds');

  void checkScheduledCampaigns();

  _timer = setInterval(() => {
    void checkScheduledCampaigns();
  }, CHECK_INTERVAL_MS);
}

export {
  startCampaignScheduler,
  checkScheduledCampaigns,
  processScheduledCampaign,
  getDueCampaigns,
  // Re-exported so campaignService.js keeps importing them from here.
  parseTime,
  istDateTimeToUtc,
  computeNextRun,
  isCampaignDue,
};
