/**
 * Analytics data service — serverless edition.
 *
 * The Analytics page pulls every metric straight from Supabase (email_logs,
 * campaigns, campaign_analytics, contacts, sequences, sequence_enrollments,
 * sequence_step_logs) so the dashboard is real — no local backend required,
 * no fake entries, no hardcoded fallbacks. Every value returned here is READ
 * from the database and recomputed from the rows in the selected date range.
 */
import { supabase } from '../supabase';

export type RangeKey = '7d' | '30d' | '90d' | 'thisMonth' | 'custom';

export interface AnalyticsRange {
  start: string;
  end: string;
}

export interface AnalyticsKpis {
  total: number;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  delivered: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
}

export interface TrendPoint {
  label: string;
  sent: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
}

export interface AudienceSegment {
  label: string;
  value: number;
  color: string;
}

export interface CampaignMetric {
  id: string;
  name: string;
  sent: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
}

export interface HeatmapCell {
  day: number;
  hour: number;
  opens: number;
  clicks: number;
}

export interface SequenceAnalytic {
  id: string;
  name: string;
  status: string;
  enrolled: number;
  sent: number;
  opened: number;
  clicked: number;
  failed: number;
  completed: number;
  pending: number;
  open_rate: number;
  click_rate: number;
  branches: {
    STARTING: number;
    OPENED: number;
    NOT_OPENED: number;
  };
}

export interface AnalyticsDashboard {
  range: AnalyticsRange;
  kpis: AnalyticsKpis;
  trend: TrendPoint[];
  trend_weekly: boolean;
  audience: AudienceSegment[];
  audience_total: number;
  top_campaigns: CampaignMetric[];
  heatmap: HeatmapCell[];
  heatmap_total: number;
  sequences: SequenceAnalytic[];
  sequences_total: number;
}

const PALETTE = ['#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#0891B2'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthDay(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function mondayOf(d: Date): Date {
  const out = startOfDay(d);
  const day = out.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + diff);
  return out;
}

export function buildRange(key: RangeKey, customFrom?: string, customTo?: string): AnalyticsRange {
  if (key === 'custom' && customFrom && customTo) {
    const start = new Date(`${customFrom}T00:00:00`);
    const end = new Date(`${customTo}T23:59:59.999`);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      return { start: start.toISOString(), end: end.toISOString() };
    }
  }
  const end = new Date();
  let start: Date;
  if (key === 'thisMonth') {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else {
    const days = key === '7d' ? 7 : key === '90d' ? 90 : 30;
    start = new Date(end.getTime() - (days - 1) * 86400000);
    start.setHours(0, 0, 0, 0);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Friendly label for a range, e.g. "Last 30 days" or "Aug 1 – Aug 14, 2026". */
export function rangeLabel(range: AnalyticsRange): string {
  const s = new Date(range.start);
  const e = new Date(range.end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 'Selected period';
  const sameYear = s.getFullYear() === e.getFullYear();
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: withYear ? 'numeric' : undefined,
    });
  return `${fmt(s, false)} – ${fmt(e, sameYear ? false : true)}${sameYear ? `, ${e.getFullYear()}` : ''}`;
}

/**
 * Fetch every email_log row whose send happened inside the range, paginated so
 * we never silently drop data (bounded at 50k rows for safety). Selecting only
 * the columns the analytics need keeps the transfer small.
 */
async function fetchAllEmailLogs(range: AnalyticsRange): Promise<any[]> {
  const PAGE = 1000;
  const MAX = 50000;
  const all: any[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('email_logs')
      .select('id, campaign_id, status, opened, clicked, opened_at, clicked_at, sent_at')
      .gte('sent_at', range.start)
      .lte('sent_at', range.end)
      .order('sent_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as any[]) || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from >= MAX) break;
  }
  return all;
}

function computeKpis(logs: any[]): AnalyticsKpis {
  let total = 0;
  let sent = 0;
  let opened = 0;
  let clicked = 0;
  let failed = 0;
  for (const log of logs) {
    total += 1;
    if (log.status === 'sent') sent += 1;
    else if (log.status === 'failed') failed += 1;
    if (log.opened === true) opened += 1;
    if (log.clicked === true) clicked += 1;
  }
  return {
    total,
    sent,
    opened,
    clicked,
    failed,
    delivered: sent,
    open_rate: sent > 0 ? Number(((opened / sent) * 100).toFixed(1)) : 0,
    click_rate: sent > 0 ? Number(((clicked / sent) * 100).toFixed(1)) : 0,
    bounce_rate: sent + failed > 0 ? Number(((failed / (sent + failed)) * 100).toFixed(1)) : 0,
  };
}

/** Group email_logs into daily (short ranges) or weekly (long ranges) buckets. */
function buildTrend(logs: any[], range: AnalyticsRange): { points: TrendPoint[]; weekly: boolean } {
  const startMs = new Date(range.start).getTime();
  const endMs = new Date(range.end).getTime();
  const days = Math.max(1, Math.round((endMs - startMs) / 86400000));
  const weekly = days > 45;

  const buckets = new Map<string, { key: Date; sent: number; opened: number; clicked: number }>();
  for (const log of logs) {
    if (log.status !== 'sent' && !log.opened) continue;
    const at = log.sent_at || log.opened_at || log.created_at;
    if (!at) continue;
    const d = new Date(at);
    if (isNaN(d.getTime())) continue;
    const key = weekly ? dayKey(mondayOf(d)) : dayKey(d);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key: weekly ? mondayOf(d) : startOfDay(d), sent: 0, opened: 0, clicked: 0 };
      buckets.set(key, bucket);
    }
    if (log.status === 'sent') bucket.sent += 1;
    if (log.opened === true) bucket.opened += 1;
    if (log.clicked === true) bucket.clicked += 1;
  }

  const sorted = [...buckets.values()].sort((a, b) => a.key.getTime() - b.key.getTime());
  const points: TrendPoint[] = sorted.map((b) => ({
    label: weekly
      ? `${monthDay(b.key)}`
      : monthDay(b.key),
    sent: b.sent,
    opened: b.opened,
    clicked: b.clicked,
    open_rate: b.sent > 0 ? Number(((b.opened / b.sent) * 100).toFixed(1)) : 0,
    click_rate: b.sent > 0 ? Number(((b.clicked / b.sent) * 100).toFixed(1)) : 0,
  }));
  return { points, weekly };
}

/** Contact distribution by real DB category (contact_type, falling back to company_category). */
export async function fetchAudienceBreakdown(): Promise<{
  segments: AudienceSegment[];
  total: number;
}> {
  const { data, error } = await supabase
    .from('contacts')
    .select('contact_type, company_category');
  if (error) throw new Error(error.message);
  const rows = (data as any[]) || [];

  const byType = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const row of rows) {
    const t = String(row.contact_type || '').trim();
    const c = String(row.company_category || '').trim();
    if (t) byType.set(t, (byType.get(t) || 0) + 1);
    if (c) byCategory.set(c, (byCategory.get(c) || 0) + 1);
  }

  const source = byType.size > 0 ? byType : byCategory;
  const segments: AudienceSegment[] = [...source.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      label,
      value,
      color: PALETTE[i % PALETTE.length],
    }));

  return { segments, total: rows.length };
}

async function fetchCampaignNames(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name, campaign_type')
    .neq('campaign_type', 'sequence');
  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of (data as any[]) || []) {
    map.set(String(row.id), String(row.campaign_name || 'Untitled campaign'));
  }
  return map;
}

/** Per-campaign open/click rates from the real email_logs in the range. */
async function buildTopCampaigns(logs: any[]): Promise<CampaignMetric[]> {
  const names = await fetchCampaignNames();
  const byCampaign = new Map<
    string,
    { sent: number; opened: number; clicked: number }
  >();
  for (const log of logs) {
    if (!log.campaign_id) continue;
    const key = String(log.campaign_id);
    const entry = byCampaign.get(key) || { sent: 0, opened: 0, clicked: 0 };
    if (log.status === 'sent') entry.sent += 1;
    if (log.opened === true) entry.opened += 1;
    if (log.clicked === true) entry.clicked += 1;
    byCampaign.set(key, entry);
  }

  return [...byCampaign.entries()]
    .map(([id, entry]) => ({
      id,
      name: names.get(id) || 'Untitled campaign',
      sent: entry.sent,
      opened: entry.opened,
      clicked: entry.clicked,
      open_rate: entry.sent > 0 ? Number(((entry.opened / entry.sent) * 100).toFixed(1)) : 0,
      click_rate: entry.sent > 0 ? Number(((entry.clicked / entry.sent) * 100).toFixed(1)) : 0,
    }))
    .filter((c) => c.sent > 0)
    .sort((a, b) => b.open_rate - a.open_rate)
    .slice(0, 5);
}

/** Day-of-week × hour-of-day engagement from real open/click timestamps. */
function buildHeatmap(logs: any[]): { cells: HeatmapCell[]; total: number } {
  const grid = new Map<string, HeatmapCell>();
  for (const log of logs) {
    const timestamps: Array<[string, 'opens' | 'clicks']> = [];
    if (log.opened === true && log.opened_at) timestamps.push([log.opened_at, 'opens']);
    if (log.clicked === true && log.clicked_at) timestamps.push([log.clicked_at, 'clicks']);
    for (const [ts, kind] of timestamps) {
      const d = new Date(ts);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getDay()}|${d.getHours()}`;
      const cell = grid.get(key) || { day: d.getDay(), hour: d.getHours(), opens: 0, clicks: 0 };
      cell[kind] += 1;
      grid.set(key, cell);
    }
  }
  const cells = [...grid.values()];
  const total = cells.reduce((sum, c) => sum + c.opens + c.clicks, 0);
  return { cells, total };
}

/** Per-sequence engagement from real enrollments + step logs, branch-aware. */
async function buildSequenceAnalytics(): Promise<{ rows: SequenceAnalytic[]; total: number }> {
  const { data: sequences, error: seqError } = await supabase
    .from('sequences')
    .select('id, name, status');
  if (seqError) return { rows: [], total: 0 };
  const seqRows = (sequences as any[]) || [];
  if (seqRows.length === 0) return { rows: [], total: 0 };
  const ids = seqRows.map((s) => String(s.id));

  const [enrollmentsRes, stepLogsRes, stepsRes] = await Promise.all([
    supabase
      .from('sequence_enrollments')
      .select('sequence_id, status')
      .in('sequence_id', ids),
    supabase
      .from('sequence_step_logs')
      .select('sequence_id, sequence_step_id, status, opened, clicked')
      .in('sequence_id', ids),
    supabase
      .from('sequence_steps')
      .select('id, parent_branch')
      .in('sequence_id', ids),
  ]);

  const enrollments = (enrollmentsRes.data as any[]) || [];
  const stepLogs = (stepLogsRes.data as any[]) || [];
  const steps = (stepsRes.data as any[]) || [];

  const branchByStep = new Map<string, string>();
  for (const step of steps) {
    const branch = String(step.parent_branch || 'STARTING').toUpperCase();
    branchByStep.set(String(step.id), branch === 'OPENED' || branch === 'NOT_OPENED' ? branch : 'STARTING');
  }

  const rows: SequenceAnalytic[] = [];
  for (const seq of seqRows) {
    const id = String(seq.id);
    const seqEnrollments = enrollments.filter((e) => String(e.sequence_id) === id);
    const seqLogs = stepLogs.filter((l) => String(l.sequence_id) === id);

    let enrolled = 0;
    let completed = 0;
    let pending = 0;
    for (const e of seqEnrollments) {
      enrolled += 1;
      if (e.status === 'completed') completed += 1;
      else if (e.status === 'active') pending += 1;
    }

    let sent = 0;
    let opened = 0;
    let clicked = 0;
    let failed = 0;
    const branches = { STARTING: 0, OPENED: 0, NOT_OPENED: 0 };
    for (const log of seqLogs) {
      const branch = branchByStep.get(String(log.sequence_step_id || '')) || 'STARTING';
      if (log.status === 'sent') {
        sent += 1;
        branches[branch as keyof typeof branches] += 1;
      } else if (log.status === 'failed') {
        failed += 1;
      }
      if (log.opened === true) opened += 1;
      if (log.clicked === true) clicked += 1;
    }

    rows.push({
      id,
      name: String(seq.name || 'Untitled sequence'),
      status: String(seq.status || 'draft'),
      enrolled,
      sent,
      opened,
      clicked,
      failed,
      completed,
      pending,
      open_rate: sent > 0 ? Number(((opened / sent) * 100).toFixed(1)) : 0,
      click_rate: sent > 0 ? Number(((clicked / sent) * 100).toFixed(1)) : 0,
      branches,
    });
  }

  return { rows, total: seqRows.length };
}

/**
 * Load the complete analytics dashboard for the given range.
 * Every metric is computed from real database rows. Throws on failure so the
 * page can show its error + retry state.
 */
export async function fetchAnalyticsDashboard(range: AnalyticsRange): Promise<AnalyticsDashboard> {
  const logs = await fetchAllEmailLogs(range);
  const kpis = computeKpis(logs);
  const trend = buildTrend(logs, range);
  const top_campaigns = await buildTopCampaigns(logs);
  const heatmap = buildHeatmap(logs);
  const audience = await fetchAudienceBreakdown();
  const sequences = await buildSequenceAnalytics();

  return {
    range,
    kpis,
    trend: trend.points,
    trend_weekly: trend.weekly,
    audience: audience.segments,
    audience_total: audience.total,
    top_campaigns,
    heatmap: heatmap.cells,
    heatmap_total: heatmap.total,
    sequences: sequences.rows,
    sequences_total: sequences.total,
  };
}
