/**
 * Campaign workflow orchestration.
 */
import * as supabaseService from './supabaseService.js';
import { processCampaign } from '../workers/emailWorker.js';
import * as emailLogService from './emailLogService.js';
import { parseTime, computeNextRun } from './campaignScheduler.js';

function buildCampaignRecord(data, status) {
  console.log('[Service] buildCampaignRecord — validating fields...');

  const subjectLine = data.subject_line !== undefined ? data.subject_line : data.subject;

  const missing = [];
  if (!data.campaign_name || !String(data.campaign_name).trim()) missing.push('campaign_name');
  if (subjectLine === undefined || subjectLine === null || !String(subjectLine).trim()) missing.push('subject_line');
  if (!data.from_name || !String(data.from_name).trim()) missing.push('from_name');
  if (!data.audience_segment || !String(data.audience_segment).trim()) missing.push('audience_segment');
  if (!data.html_content || !String(data.html_content).trim()) missing.push('html_content');
  if (missing.length > 0) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  const record = {
    id: data.id ? String(data.id) : null,
    campaign_name: String(data.campaign_name).trim(),
    subject_line: String(subjectLine).trim(),
    from_name: String(data.from_name).trim(),
    audience_segment: String(data.audience_segment).trim(),
    campaign_type: String(data.campaign_type || 'Campaign').trim(),
    email_body: data.html_content,
    html_content: data.html_content,
    template_name: data.template_name ? String(data.template_name).trim() : null,
    template_id: data.template_id ? String(data.template_id).trim() : null,
    schedule_date: data.schedule_date ? String(data.schedule_date).trim() : null,
    schedule_time: data.schedule_time ? String(data.schedule_time).trim() : null,
    status,
  };

  console.log('[Service] buildCampaignRecord — record built:');
  console.log('[Service]   id:', record.id);
  console.log('[Service]   campaign_name:', record.campaign_name);
  console.log('[Service]   subject_line:', record.subject_line);
  console.log('[Service]   from_name:', record.from_name);
  console.log('[Service]   audience_segment:', record.audience_segment);
  console.log('[Service]   status:', record.status);
  console.log('[Service]   html_content length:', (record.html_content || '').length);

  return record;
}

function kickOffSending(saved) {
  console.log('[Service] kickOffSending — triggering background worker for campaign:', saved.id);
  processCampaign(saved.id)
    .then((result) => {
      console.log('[Service] kickOffSending — worker COMPLETED SUCCESSFULLY for campaign:', saved.id);
      console.log('[Service] Result:', JSON.stringify(result));
    })
    .catch((err) => {
      console.error('[Service] kickOffSending — worker FAILED for campaign:', saved.id);
      console.error('[Service] Error message:', err.message);
      console.error('[Service] Error stack:', err.stack);
    });
}

// ─── Recurring schedule persistence ────────────────────────────────────────

/**
 * Normalize a 12h/24h time string to "HH:MM:SS" for the TIME column.
 * Falls back to the raw value when it cannot be parsed.
 */
function normalizeTimeToStore(timeStr) {
  if (!timeStr) return null;
  const t = parseTime(timeStr);
  if (!t) return String(timeStr).trim();
  return [
    String(t.hours).padStart(2, '0'),
    String(t.minutes).padStart(2, '0'),
    String(t.seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Build a campaign_schedules row from the schedule payload, including next_run.
 */
function buildScheduleRow(input) {
  const row = {
    schedule_type: input.schedule_type,
    start_date: input.start_date || null,
    send_time: normalizeTimeToStore(input.send_time),
    repeat_interval:
      input.repeat_interval != null ? Math.max(1, Number(input.repeat_interval) || 1) : 1,
    weekly_days:
      Array.isArray(input.weekly_days) && input.weekly_days.length > 0
        ? input.weekly_days.join(', ')
        : null,
    monthly_type: input.monthly_type || null,
    day_of_month: input.day_of_month != null ? Number(input.day_of_month) : null,
    week_number: input.week_number || null,
    weekday: input.weekday || null,
    timezone: input.timezone || 'Asia/Kolkata',
  };
  const next = computeNextRun(row);
  return { ...row, next_run: next ? next.toISOString() : null };
}

/**
 * Persist the schedule settings when the campaign payload carries one.
 * Always replaces any previous schedule row for the campaign.
 */
async function persistScheduleIfPresent(saved, data) {
  if (
    !data.schedule ||
    !['one_time', 'weekly', 'monthly'].includes(data.schedule.schedule_type)
  ) {
    return;
  }
  const row = buildScheduleRow(data.schedule);
  const persisted = await supabaseService.replaceCampaignSchedule(saved.id, row);
  console.log('[Service] Schedule persisted for campaign:', saved.id, JSON.stringify(persisted));
}

// ─── Frontend-compatible one-step workflows ────────────────────────────────

export async function sendCampaignFlow(data) {
  console.log('\n[Service] ═══════════════════════════════════════════════════════');
  console.log('[Service] sendCampaignFlow — START');
  console.log('[Service] ═══════════════════════════════════════════════════════');
  console.log('[Service] Input data keys:', Object.keys(data));

  try {
    const record = buildCampaignRecord(data, 'pending');

    console.log('[Service] Saving campaign to Supabase...');
    const saved = await supabaseService.saveCampaign(record);
    console.log('[Service] Campaign saved. ID:', saved.id, 'Status:', saved.status);

    await persistScheduleIfPresent(saved, data);

    kickOffSending(saved);

    const result = {
      campaign_id: saved.id,
      status: 'sending',
      message: 'Campaign is being sent.',
      recipient_count: 0,
    };

    console.log('[Service] sendCampaignFlow — returning:', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('[Service] sendCampaignFlow — FAILED');
    console.error('[Service] Error:', error.message);
    console.error('[Service] Stack:', error.stack);
    throw error;
  }
}

export async function scheduleCampaignFlow(data) {
  const saved = await supabaseService.saveCampaign(
    buildCampaignRecord(data, 'scheduled')
  );
  await persistScheduleIfPresent(saved, data);
  return {
    campaign_id: saved.id,
    status: 'scheduled',
    scheduled_at: `${data.schedule_date} ${data.schedule_time}`,
    message: 'Campaign scheduled.',
  };
}

export async function saveDraftFlow(data) {
  const saved = await supabaseService.saveCampaign(buildCampaignRecord(data, 'draft'));
  await persistScheduleIfPresent(saved, data);
  return saved;
}

// ─── RESTful CRUD ─────────────────────────────────────────────────────────

export async function createCampaignFlow(data) {
  return supabaseService.saveCampaign(buildCampaignRecord(data, 'pending'));
}

export async function listCampaignsFlow() {
  const campaigns = await supabaseService.listCampaigns();
  const ids = campaigns.map((c) => c.id);

  // Source of truth for open/click metrics is campaign_analytics (maintained
  // by the tracking RPCs + worker sync). email_logs stats are only a fallback
  // for rows that predate the analytics table.
  const analyticsByCampaign = await supabaseService.getAnalyticsForCampaigns(ids);
  const statsByCampaign = await emailLogService.getLogsStatsForCampaigns(ids);

  return campaigns.map((campaign) => {
    const analytics = analyticsByCampaign[campaign.id];
    const stats = statsByCampaign[campaign.id] || {
      delivered: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0,
    };

    const delivered = analytics && analytics.delivered != null
      ? Number(analytics.delivered)
      : Number(stats.delivered) || 0;
    const opened = analytics && analytics.opened != null
      ? Number(analytics.opened)
      : Number(stats.opened) || 0;
    const clicked = analytics && analytics.clicked != null
      ? Number(analytics.clicked)
      : Number(stats.clicked) || 0;
    const open_rate = analytics && analytics.open_rate != null
      ? Number(analytics.open_rate)
      : Number(stats.open_rate) || 0;
    const click_rate = analytics && analytics.click_rate != null
      ? Number(analytics.click_rate)
      : Number(stats.click_rate) || 0;

    return {
      ...campaign,
      delivered,
      opened,
      clicked,
      sent_count: delivered,
      delivered_count: delivered,
      opened_count: opened,
      clicked_count: clicked,
      open_rate,
      click_rate,
      recipient_count: Number(campaign.recipient_count) || 0,
    };
  });
}

export async function getCampaignFlow(id) {
  const campaign = await supabaseService.getCampaign(id);
  const stats = await emailLogService.getLogsStats(id);
  const analytics = await supabaseService.getCampaignAnalytics(id);
  const logs = await emailLogService.getLogsByCampaign(id);

  const delivered = analytics && analytics.delivered != null
    ? Number(analytics.delivered)
    : Number(stats.delivered) || 0;
  const opened = analytics && analytics.opened != null
    ? Number(analytics.opened)
    : Number(stats.opened) || 0;
  const clicked = analytics && analytics.clicked != null
    ? Number(analytics.clicked)
    : Number(stats.clicked) || 0;
  const open_rate = analytics && analytics.open_rate != null
    ? Number(analytics.open_rate)
    : Number(stats.open_rate) || 0;
  const click_rate = analytics && analytics.click_rate != null
    ? Number(analytics.click_rate)
    : Number(stats.click_rate) || 0;

  return {
    ...campaign,
    delivered,
    opened,
    clicked,
    sent_count: delivered,
    delivered_count: delivered,
    opened_count: opened,
    clicked_count: clicked,
    open_rate,
    click_rate,
    recipient_count: Number(campaign.recipient_count) || 0,
    email_stats: stats,
    email_logs: logs,
    analytics,
  };
}

export async function updateCampaignFlow(id, data) {
  const existing = await supabaseService.getCampaign(id);
  const merged = { ...existing, ...data, id };
  return supabaseService.saveCampaign(merged);
}

export async function deleteCampaignFlow(id) {
  return supabaseService.deleteCampaign(id);
}

// ─── Send / Schedule existing campaign ────────────────────────────────────

export async function sendExistingCampaignFlow(id) {
  const campaign = await supabaseService.getCampaign(id);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  if (campaign.status === 'sending' || campaign.status === 'sent') {
    const err = new Error(`Campaign is already ${campaign.status}`);
    err.status = 400;
    throw err;
  }

  await supabaseService.updateCampaignStatus(id, { status: 'pending' });
  kickOffSending({ id });

  return {
    campaign_id: id,
    status: 'sending',
    message: 'Campaign is being sent.',
  };
}

export async function scheduleExistingCampaignFlow(id, scheduleDate, scheduleTime) {
  const campaign = await supabaseService.getCampaign(id);
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  await supabaseService.updateCampaignStatus(id, {
    status: 'scheduled',
    schedule_date: scheduleDate,
    schedule_time: scheduleTime,
  });

  return {
    campaign_id: id,
    status: 'scheduled',
    scheduled_at: `${scheduleDate} ${scheduleTime}`,
    message: 'Campaign scheduled.',
  };
}
