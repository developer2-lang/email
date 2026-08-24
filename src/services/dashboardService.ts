/**
 * Dashboard data service — serverless edition.
 *
 * Pulls the dashboard's "Recent Activity" feed, enrollment stats and top
 * engaged contacts straight from Supabase (email_logs / sequence_step_logs /
 * sequence_enrollments joined with campaigns, contacts and sequences), so the
 * dashboard shows real activity — no local backend required, no fake entries.
 *
 * Every value returned here is READ from the database. Nothing is hardcoded.
 */
import { supabase } from '../supabase'

export type ActivityType = 'sent' | 'opened' | 'clicked' | 'enrolled' | 'seq'

export interface ActivityItem {
  id: string
  type: ActivityType
  /** Name used for the avatar initials (contact name or campaign/sequence). */
  person?: string
  company?: string
  /** Plain-text, safe summary line (React-escaped when rendered). */
  title: string
  /** Raw ISO timestamp used for sorting. */
  timestamp: string
  /** Human-readable relative label ("Today, 10:32 AM"). */
  time: string
}

export interface EngagedContact {
  id: string
  name: string
  company: string
  opens: number
  clicks: number
  score: number
}

/** Compact relative label for a timestamp: "Today, 10:32 AM" / "Yesterday, 4:15 PM". */
function relativeTimeLabel(input?: string | null): string {
  if (!input) return ''
  const date = new Date(input)
  if (isNaN(date.getTime())) return ''
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfDay) / 86400000)
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  if (dayDiff === 0) return `Today, ${time}`
  if (dayDiff === 1) return `Yesterday, ${time}`
  return (
    date.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    }) +
    `, ${time}`
  )
}

/** Collision-free local id for feed rows (no crypto dependency). */
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function personName(contact: any): string {
  if (!contact) return ''
  return String(contact.full_name || contact.email || '').trim()
}

function companyName(contact: any): string {
  if (!contact || !contact.company) return ''
  return String(contact.company).trim()
}

/**
 * Recent activity feed — a single merged, time-sorted list built from real
 * database events:
 *   - campaign sends (grouped per campaign, non-sequence campaigns only)
 *   - per-recipient opens and clicks (from email_logs)
 *   - per-recipient sequence step sends + contacts enrolled in sequences
 *
 * Returns [] on any failure so the dashboard degrades gracefully.
 */
export async function fetchRecentActivity(): Promise<ActivityItem[]> {
  const seeds: Array<Omit<ActivityItem, 'time'>> = []

  try {
    const { data: logs } = await supabase
      .from('email_logs')
      .select(
        'id, campaign_id, campaigns(campaign_name, campaign_type), contacts(full_name, company), opened, opened_at, clicked, clicked_at, sent_at, status, created_at'
      )
      .not('campaign_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(300)

    // Campaign sends (grouped per campaign, sequence campaigns excluded — they
    // surface through the sequence activity below instead).
    const campaignLogs = new Map<string, { name: string; sentAt: string; count: number }>()
    for (const log of (logs as any[]) || []) {
      const campaign: any = log.campaigns || null
      if (!campaign) continue
      if (String(campaign.campaign_type || '').toLowerCase() === 'sequence') continue
      const key = String(log.campaign_id)
      const entry = campaignLogs.get(key) || {
        name: String(campaign.campaign_name || 'Untitled campaign'),
        sentAt: '',
        count: 0,
      }
      if (log.status === 'sent' || log.opened === true) {
        entry.count += 1
        if (!entry.sentAt) entry.sentAt = String(log.sent_at || log.created_at || '')
        campaignLogs.set(key, entry)
      }
    }
    for (const entry of campaignLogs.values()) {
      if (entry.count > 0 && entry.sentAt) {
        seeds.push({
          id: uid('sent'),
          type: 'sent',
          person: entry.name,
          title: `${entry.name} sent to ${entry.count} ${entry.count === 1 ? 'contact' : 'contacts'}`,
          timestamp: entry.sentAt,
        })
      }
    }

    // Per-recipient opens and clicks (real tracking events).
    for (const log of (logs as any[]) || []) {
      const contact: any = log.contacts || null
      if (!contact) continue
      const campaign: any = log.campaigns || null
      const name = personName(contact)
      if (!name) continue
      const target = campaign ? String(campaign.campaign_name || 'a campaign') : 'a campaign'
      const company = companyName(contact)

      if (log.opened === true) {
        seeds.push({
          id: uid('open'),
          type: 'opened',
          person: name,
          company: company || undefined,
          title: `${name} opened ${target}`,
          timestamp: String(log.opened_at || log.created_at || ''),
        })
      }
      if (log.clicked === true) {
        seeds.push({
          id: uid('click'),
          type: 'clicked',
          person: name,
          company: company || undefined,
          title: `${name} clicked ${target}`,
          timestamp: String(log.clicked_at || log.created_at || ''),
        })
      }
    }
  } catch (err) {
    console.warn('[dashboardService] email activity fetch failed:', (err as Error).message)
  }

  try {
    const { data: stepLogs } = await supabase
      .from('sequence_step_logs')
      .select('id, sent_at, sequence_id, sequences(name), contact_id, contacts(full_name, company)')
      .order('sent_at', { ascending: false })
      .limit(20)

    for (const log of (stepLogs as any[]) || []) {
      const sequence: any = log.sequences || null
      const contact: any = log.contacts || null
      if (!log.sent_at) continue
      const name = personName(contact)
      if (!name) continue
      const seqName = sequence && sequence.name ? String(sequence.name) : 'a sequence'
      const company = companyName(contact)
      seeds.push({
        id: uid('seq'),
        type: 'seq',
        person: name,
        company: company || undefined,
        title: `${name} received a step of ${seqName}`,
        timestamp: String(log.sent_at),
      })
    }

    const { data: enrollments } = await supabase
      .from('sequence_enrollments')
      .select('enrolled_at, sequence_id, sequences(name)')
      .order('enrolled_at', { ascending: false })
      .limit(40)

    // Group enrollments per sequence + day so the feed stays readable.
    const enrolledBySeq = new Map<string, { name: string; at: string; count: number }>()
    for (const row of (enrollments as any[]) || []) {
      const sequence: any = row.sequences || null
      if (!sequence || !row.enrolled_at) continue
      const key = `${String(row.sequence_id)}|${new Date(row.enrolled_at).toISOString().slice(0, 10)}`
      const entry = enrolledBySeq.get(key) || {
        name: String(sequence.name || 'Sequence'),
        at: String(row.enrolled_at),
        count: 0,
      }
      entry.count += 1
      enrolledBySeq.set(key, entry)
    }
    for (const entry of enrolledBySeq.values()) {
      seeds.push({
        id: uid('enroll'),
        type: 'enrolled',
        title: `${entry.count} ${entry.count === 1 ? 'contact' : 'contacts'} enrolled in ${entry.name}`,
        timestamp: entry.at,
      })
    }
  } catch (err) {
    console.warn('[dashboardService] sequence activity fetch failed:', (err as Error).message)
  }

  return seeds
    .filter((s) => s.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5)
    .map((s) => ({ ...s, time: relativeTimeLabel(s.timestamp) }))
}

/**
 * Number of contacts currently enrolled across ALL active sequences
 * (distinct contact_id). 0 on failure.
 */
export async function fetchEnrolledContactsCount(): Promise<number> {
  try {
    const { data } = await supabase.from('sequence_enrollments').select('contact_id, sequences(status)')
    const ids = new Set<string>()
    for (const row of (data as any[]) || []) {
      const sequence: any = row.sequences || null
      if (sequence && String(sequence.status) === 'active') ids.add(String(row.contact_id))
    }
    return ids.size
  } catch {
    return 0
  }
}

/**
 * Most-engaged contacts computed from REAL email_logs tracking data
 * (opened/clicked events per contact, joined with contacts). Sorted by a
 * simple engagement score (opens + clicks × 2). Returns [] when there is no
 * tracking data.
 *
 * Scoped to the most recent 1000 tracking rows so the query stays bounded and
 * cheap — plenty for a meaningful "top engaged" list.
 */
export async function fetchTopEngagedContacts(limit = 5): Promise<EngagedContact[]> {
  try {
    const { data: logs } = await supabase
      .from('email_logs')
      .select('contact_id, contacts(full_name, company), opened, clicked')
      .order('created_at', { ascending: false })
      .limit(1000)

    const byContact = new Map<string, { name: string; company: string; opens: number; clicks: number }>()
    for (const log of (logs as any[]) || []) {
      if (!log.contact_id) continue
      const contact: any = log.contacts || null
      const key = String(log.contact_id)
      const entry = byContact.get(key) || {
        name: personName(contact) || 'Contact',
        company: companyName(contact),
        opens: 0,
        clicks: 0,
      }
      if (log.opened === true) entry.opens += 1
      if (log.clicked === true) entry.clicks += 1
      byContact.set(key, entry)
    }

    return [...byContact.entries()]
      .map(([id, entry]) => ({
        id,
        name: entry.name,
        company: entry.company,
        opens: entry.opens,
        clicks: entry.clicks,
        score: entry.opens + entry.clicks * 2,
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  } catch (err) {
    console.warn('[dashboardService] top engaged fetch failed:', (err as Error).message)
    return []
  }
}