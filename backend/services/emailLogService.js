/**
 * Email log data-access layer.
 *
 * All per-email send results are stored in the `email_logs` table.
 *
 * REQUIRED TABLE — create via Supabase Dashboard → SQL Editor:
 *
 *   CREATE TABLE email_logs (
 *     id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *     campaign_id    UUID NOT NULL,
 *     contact_id     UUID NOT NULL,
 *     email          TEXT NOT NULL,
 *     status         TEXT NOT NULL DEFAULT 'pending',
 *     error_message  TEXT,
 *     sent_at        TIMESTAMPTZ,
 *     retry_count    INTEGER DEFAULT 0,
 *     last_attempt_at TIMESTAMPTZ,
 *     next_retry_at  TIMESTAMPTZ,
 *     created_at     TIMESTAMPTZ DEFAULT NOW()
 *   );
 *
 *   CREATE INDEX idx_email_logs_campaign ON email_logs(campaign_id);
 *   CREATE INDEX idx_email_logs_status   ON email_logs(status);
 */
import { randomUUID } from 'node:crypto';
import { supabase } from './supabaseService.js';

const TABLE = 'email_logs';

let _trackingColumnsChecked = false;
let _trackingColumnsPresent = false;

/**
 * Detect whether the open/click tracking columns exist on email_logs.
 * The result is cached for the process lifetime. Tracking is optional: if the
 * migration (backend/email_tracking_migration.sql) has not been applied yet,
 * emails are sent without the pixel/click rewriting instead of failing.
 */
async function trackingColumnsPresent() {
  if (_trackingColumnsChecked) return _trackingColumnsPresent;
  const { error } = await supabase
    .from(TABLE)
    .select('tracking_id, opened, clicked')
    .limit(1);
  _trackingColumnsPresent = !(error && error.code === '42703');
  _trackingColumnsChecked = true;
  return _trackingColumnsPresent;
}

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  return wrapped;
}

/**
 * Bulk-insert email log entries.
 */
export async function createEmailLogs(logs) {
  if (!logs || logs.length === 0) return [];

  const tracking = await trackingColumnsPresent();

  const rows = logs.map((l) => {
    if (!l.campaign_id || !l.contact_id || !l.email) {
      throw new Error('Invalid email log entry: campaign_id, contact_id, and email are required');
    }
    const row = {
      campaign_id: l.campaign_id,
      contact_id: l.contact_id,
      email: l.email,
      status: l.status || 'pending',
      retry_count: 0,
    };
    if (tracking) row.tracking_id = randomUUID();
    return row;
  });

  console.log(`[EmailLog] createEmailLogs — inserting ${rows.length} rows for campaign_id=${rows[0].campaign_id}`);
  console.log(`[EmailLog] createEmailLogs — sample row: ${JSON.stringify(rows[0])}`);

  const { data, error } = await supabase.from(TABLE).insert(rows).select('*');
  if (error) throw toError(error, 'Failed to create email logs');

  const inserted = data || [];
  console.log(`[EmailLog] createEmailLogs DONE — inserted ${inserted.length} rows`);
  for (const row of inserted) {
    console.log(`[EmailLog] inserted row: id=${row.id} campaign_id=${row.campaign_id} contact_id=${row.contact_id} email=${row.email} tracking_id=${row.tracking_id}`);
  }

  return inserted;
}

/**
 * Update a single email log entry.
 */
export async function updateEmailLog(id, updates) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw toError(error, 'Failed to update email log');
  return data;
}

/**
 * Fetch pending emails for a campaign, ready to be sent.
 */
export async function getPendingEmailLogs(campaignId, limit = 20) {
  if (!campaignId) throw new Error('campaignId is required to fetch pending email logs');
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw toError(error, 'Failed to fetch pending email logs');
  return data || [];
}

/**
 * Return all log entries for a campaign.
 */
export async function getLogsByCampaign(campaignId) {
  if (!campaignId) throw new Error('campaignId is required to fetch email logs by campaign');
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true });

  if (error) throw toError(error, 'Failed to fetch email logs');
  return data || [];
}

/**
 * Return aggregated send + engagement statistics for a campaign.
 *
 * Delivered = rows with status 'sent'. Open / click counts come from the
 * tracking columns updated by the tracking pixel / click-link endpoints.
 */
export async function getLogsStats(campaignId) {
  const logs = await getLogsByCampaign(campaignId);

  const delivered = logs.filter((l) => l.status === 'sent').length;
  const opened = logs.filter((l) => l.opened === true).length;
  const clicked = logs.filter((l) => l.clicked === true).length;

  return {
    total: logs.length,
    sent: delivered,
    sent_count: delivered,
    delivered: delivered,
    opened: opened,
    clicked: clicked,
    failed: logs.filter((l) => l.status === 'failed').length,
    pending: logs.filter((l) => l.status === 'pending').length,
    open_rate: delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0,
    click_rate: delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0,
  };
}

/**
 * Compute the same per-campaign metrics for many campaigns in a single query.
 * Used by the campaign list endpoint to avoid N+1 queries.
 *
 * @param {string[]} campaignIds
 * @returns {Promise<Record<string, object>>} keyed by campaign id.
 */
export async function getLogsStatsForCampaigns(campaignIds) {
  const empty = () => ({
    total: 0, sent: 0, sent_count: 0, delivered: 0, opened: 0, clicked: 0,
    failed: 0, pending: 0, open_rate: 0, click_rate: 0,
  });
  const byCampaign = {};
  for (const id of campaignIds) byCampaign[id] = empty();

  if (!campaignIds || campaignIds.length === 0) return byCampaign;

  // The open/click tracking columns are optional (migration may not be applied
  // yet). Fall back to status-only stats if they are missing.
  let { data, error } = await supabase
    .from(TABLE)
    .select('campaign_id, status, opened, clicked')
    .in('campaign_id', campaignIds);
  if (error && error.code === '42703') {
    const fallback = await supabase
      .from(TABLE)
      .select('campaign_id, status')
      .in('campaign_id', campaignIds);
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw toError(error, 'Failed to fetch email log stats');

  for (const log of data || []) {
    const stats = byCampaign[log.campaign_id];
    if (!stats) continue;
    stats.total++;
    if (log.status === 'sent') {
      stats.sent++;
      stats.delivered++;
    } else if (log.status === 'failed') {
      stats.failed++;
    } else if (log.status === 'pending') {
      stats.pending++;
    }
    if (log.opened === true) stats.opened++;
    if (log.clicked === true) stats.clicked++;
  }

  for (const id of campaignIds) {
    const stats = byCampaign[id];
    stats.sent_count = stats.delivered;
    stats.open_rate = stats.delivered > 0
      ? Number(((stats.opened / stats.delivered) * 100).toFixed(1))
      : 0;
    stats.click_rate = stats.delivered > 0
      ? Number(((stats.clicked / stats.delivered) * 100).toFixed(1))
      : 0;
  }

  return byCampaign;
}

/**
 * Create/refresh the campaign_analytics row for a campaign from email_logs.
 *
 * The open/click counts and rates live in campaign_analytics (maintained by
 * the record_email_open / record_email_click RPCs on every pixel/link hit).
 * This function seeds the row when a campaign is first sent and refreshes the
 * derived fields (delivered, total_recipients) after sending completes, while
 * preserving any opens/clicks already recorded by the RPCs.
 *
 * @param {string} campaignId
 */
export async function syncCampaignAnalytics(campaignId) {
  if (!campaignId) throw new Error('campaignId is required to sync campaign analytics');

  const stats = await getLogsStats(campaignId);

  const opened = stats.opened;
  const clicked = stats.clicked;

  console.log(`[EmailLog] syncCampaignAnalytics — campaign: ${campaignId}`);
  console.log(`[EmailLog]   total_recipients: ${stats.total}, delivered: ${stats.delivered}, opened: ${opened}, clicked: ${clicked}`);

  const { data, error } = await supabase
    .from('campaign_analytics')
    .upsert(
      {
        campaign_id: campaignId,
        total_recipients: stats.total,
        delivered: stats.delivered,
        opened,
        clicked,
        open_rate: stats.delivered > 0
          ? Number(((opened / stats.delivered) * 100).toFixed(1))
          : 0,
        click_rate: stats.delivered > 0
          ? Number(((clicked / stats.delivered) * 100).toFixed(1))
          : 0,
      },
      { onConflict: 'campaign_id' }
    )
    .select('*')
    .single();

  if (error) {
    console.error(`[EmailLog] syncCampaignAnalytics FAILED — campaign: ${campaignId}, error: ${error.message}`);
    const message = String(error.message || '').toLowerCase();
    if (message.includes('cannot insert into view') || message.includes('cannot update view') || message.includes('55000')) {
      console.warn('[EmailLog] campaign_analytics appears to be a view; skipping analytics sync.');
      return null;
    }
    throw toError(error, 'Failed to sync campaign analytics');
  }

  console.log(`[EmailLog] syncCampaignAnalytics DONE — campaign_analytics: ${JSON.stringify(data)}`);
  return data;
}

// ─── Sequence step-log → email_log link backfill ──────────────────────────
//
// sequence_step_logs.email_log_id is the branch's tracking link: eligibility,
// Step Progress and engagement all read the authoritative open/click record
// from email_logs THROUGH that link. Sends written by older code left the link
// NULL, so the open/click data never reached the sequence calculation. This
// backfill matches each unlinked step log to the real email_log row under the
// sequence's dedicated campaign (same contact, closest sent_at) and writes the
// link back — a self-heal that runs from the worker and from getSequence.
const LINK_MATCH_WINDOW_MS = 5 * 60 * 1000;
const _backfilledSequenceIds = new Set();
const _trackingSyncedSequenceIds = new Set();

/**
 * Pick the email_log row that belongs to a step log for the SAME contact.
 * Prefers the row whose sent_at is closest to the step log's sent_at (within
 * LINK_MATCH_WINDOW_MS); when the step log has no sent_at, returns the most
 * recent email_log for that contact.
 *
 * @param {Array<{id:string, contact_id:string, sent_at:string|null}>} emailLogs
 * @param {{contact_id:string, sent_at:string|null}} stepLog
 * @returns {object|null}
 */
function pickEmailLogForStepLog(emailLogs, stepLog) {
  const candidates = (emailLogs || []).filter((l) => l.contact_id === stepLog.contact_id);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const target = stepLog.sent_at ? new Date(stepLog.sent_at).getTime() : null;
  if (!Number.isFinite(target)) {
    return candidates
      .slice()
      .sort((a, b) => new Date(b.sent_at || 0).getTime() - new Date(a.sent_at || 0).getTime())[0];
  }

  let best = null;
  let bestDist = Infinity;
  for (const log of candidates) {
    const at = new Date(log.sent_at || 0).getTime();
    const dist = Number.isFinite(at) ? Math.abs(at - target) : Infinity;
    if (dist < bestDist) {
      bestDist = dist;
      best = log;
    }
  }
  if (!best || bestDist > LINK_MATCH_WINDOW_MS) return null;
  return best;
}

/**
 * Backfill sequence_step_logs.email_log_id for legacy rows that were written
 * without the link. Idempotent per sequence for the process lifetime: once a
 * sequence has been reconciled it is not re-scanned (new sends always write the
 * link themselves).
 *
 * @param {string} sequenceId
 * @returns {Promise<number>} rows newly linked
 */
export async function backfillStepLogEmailLinks(sequenceId) {
  if (!sequenceId || _backfilledSequenceIds.has(sequenceId)) return 0;
  const { data: sequence, error: seqError } = await supabase
    .from('sequences')
    .select('id, campaign_id')
    .eq('id', sequenceId)
    .maybeSingle();
  if (seqError) throw toError(seqError, 'Failed to fetch sequence for link backfill');
  if (!sequence || !sequence.campaign_id) {
    _backfilledSequenceIds.add(sequenceId);
    return 0;
  }

  const { data: stepLogs, error: slError } = await supabase
    .from('sequence_step_logs')
    .select('id, contact_id, email_log_id, sent_at')
    .eq('sequence_id', sequenceId);
  if (slError) throw toError(slError, 'Failed to fetch step logs for link backfill');

  const missing = (stepLogs || []).filter((l) => !l.email_log_id && l.contact_id);
  let linked = 0;
  if (missing.length > 0) {
    const contactIds = [...new Set(missing.map((l) => l.contact_id))];
    const { data: emailLogs, error: elError } = await supabase
      .from('email_logs')
      .select('id, contact_id, sent_at')
      .eq('campaign_id', sequence.campaign_id)
      .in('contact_id', contactIds);
    if (elError) throw toError(elError, 'Failed to fetch email logs for link backfill');

    for (const stepLog of missing) {
      const match = pickEmailLogForStepLog(emailLogs || [], stepLog);
      if (!match) continue;
      const { error: upError } = await supabase
        .from('sequence_step_logs')
        .update({ email_log_id: match.id })
        .eq('id', stepLog.id);
      if (upError) throw toError(upError, 'Failed to backfill step log email link');
      linked += 1;
    }
  }

  _backfilledSequenceIds.add(sequenceId);
  if (linked > 0) {
    console.log(`[EmailLog] backfilled ${linked} missing step-log → email_log links for sequence ${sequenceId}`);
  }
  return linked;
}

// ─── Sequence step-log tracking sync ───────────────────────────────────────
//
// `sequence_step_logs` carries its own opened/opened_at/clicked/clicked_at
// columns, but the authoritative tracking record lives in `email_logs` (that is
// what the open pixel / click link actually updates). Historically nothing ever
// synced the email_log record into the step log, so step-log flagged reads
// (the sequence Logs API, and the eligibility fallback for unlinked rows)
// showed Opened = false even for genuinely opened emails. These helpers keep
// the step-log flags in line with the real email_log record.

/**
 * Copy tracking fields from an email_log onto every sequence_step_log linked
 * to it (via email_log_id). Best-effort and idempotent — never throws.
 *
 * @param {string} emailLogId
 * @param {{opened?: boolean, opened_at?: string, clicked?: boolean, clicked_at?: string}} fields
 */
export async function syncStepLogFromEmailLog(emailLogId, fields) {
  if (!emailLogId) return;
  const updates = {};
  if (fields && fields.opened !== undefined) updates.opened = fields.opened === true;
  if (fields && fields.opened_at) updates.opened_at = fields.opened_at;
  if (fields && fields.clicked !== undefined) updates.clicked = fields.clicked === true;
  if (fields && fields.clicked_at) updates.clicked_at = fields.clicked_at;
  if (Object.keys(updates).length === 0) return;

  const { error } = await supabase
    .from('sequence_step_logs')
    .update(updates)
    .eq('email_log_id', emailLogId);
  if (error) {
    console.warn(`[EmailLog] syncStepLogFromEmailLog failed for email_log ${emailLogId}: ${error.message}`);
  }
}

/**
 * Reconcile every linked step log of a sequence against its email_log so the
 * step-log tracking flags mirror the authoritative tracking record. Self-heals
 * rows recorded before this sync existed and runs once per sequence per process
 * (new opens/clicks are kept in sync live by the tracking service).
 *
 * @param {string} sequenceId
 * @returns {Promise<number>} rows whose flags were changed
 */
export async function syncStepLogTrackingFromLinks(sequenceId) {
  if (!sequenceId || _trackingSyncedSequenceIds.has(sequenceId)) return 0;

  const { data: stepLogs, error } = await supabase
    .from('sequence_step_logs')
    .select('id, email_log_id')
    .eq('sequence_id', sequenceId)
    .not('email_log_id', 'is', null);
  if (error) throw toError(error, 'Failed to load step logs for tracking sync');

  const emailLogIds = [...new Set((stepLogs || []).map((l) => l.email_log_id).filter(Boolean))];
  let updated = 0;
  if (emailLogIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('email_logs')
      .select('id, opened, opened_at, clicked, clicked_at')
      .in('id', emailLogIds);
    if (logsError) throw toError(logsError, 'Failed to load email logs for tracking sync');

    const byId = new Map((logs || []).map((l) => [l.id, l]));
    for (const stepLog of stepLogs || []) {
      const emailLog = byId.get(stepLog.email_log_id);
      if (!emailLog) continue;
      const updates = {
        opened: emailLog.opened === true,
        clicked: emailLog.clicked === true,
      };
      if (emailLog.opened_at) updates.opened_at = emailLog.opened_at;
      if (emailLog.clicked_at) updates.clicked_at = emailLog.clicked_at;

      if (
        stepLog.opened === updates.opened &&
        stepLog.clicked === updates.clicked &&
        (stepLog.opened_at || null) === (updates.opened_at || null) &&
        (stepLog.clicked_at || null) === (updates.clicked_at || null)
      ) {
        continue;
      }

      const { error: upError } = await supabase
        .from('sequence_step_logs')
        .update(updates)
        .eq('id', stepLog.id);
      if (!upError) updated += 1;
    }
  }

  _trackingSyncedSequenceIds.add(sequenceId);
  if (updated > 0) {
    console.log(`[EmailLog] synced ${updated} step-log tracking flag(s) from email_logs for sequence ${sequenceId}`);
  }
  return updated;
}
