/**
 * Shared campaign-schedule time helpers.
 *
 * The UI stores schedule values as IST (Asia/Kolkata) wall-clock:
 *   - schedule_date: "YYYY-MM-DD"
 *   - schedule_time: "10:00 AM", "10:00:00", "14:21", "14:21:00"
 *
 * These helpers convert an IST wall-clock instant into the absolute UTC Date it
 * represents (independent of the server's local timezone) and compute the next
 * occurrence of recurring (weekly/monthly) schedules. They are used by the
 * local campaign scheduler, the local send flow, and mirrored by the Supabase
 * Edge Functions (which cannot import Node modules).
 */

// IST (Asia/Kolkata) = UTC+05:30.
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Parse a time string into { hours, minutes, seconds }.
 * Accepts "10:00 AM", "10:00:00 AM", "14:21", "14:21:00", "23:59:59".
 *
 * @param {string} timeStr
 * @returns {{hours: number, minutes: number, seconds: number} | null}
 */
export function parseTime(timeStr) {
  if (!timeStr) return null;
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  const meridian = (match[4] || '').toUpperCase();

  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  if (meridian === 'PM' && hours !== 12) hours += 12;
  if (meridian === 'AM' && hours === 12) hours = 0;

  return { hours, minutes, seconds };
}

/**
 * Combine an IST wall-clock date/time into the equivalent UTC Date instant.
 *
 * @param {string} dateStr "YYYY-MM-DD" (IST calendar date)
 * @param {string} timeStr IST time in 12h/24h form
 * @returns {Date | null}
 */
export function istDateTimeToUtc(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const dateMatch = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const time = parseTime(timeStr);
  if (!time) return null;

  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);

  // Validate the calendar date (reject e.g. 2026-02-31).
  const localCalendar = new Date(Date.UTC(year, month - 1, day));
  if (
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() !== month - 1 ||
    localCalendar.getUTCDate() !== day
  ) {
    return null;
  }

  // Build the wall-clock time as if it were UTC, then subtract the IST offset
  // to obtain the true UTC instant. This is timezone-independent.
  const asUtc = Date.UTC(year, month - 1, day, time.hours, time.minutes, time.seconds);
  const utcInstant = new Date(asUtc - IST_OFFSET_MS);
  return Number.isNaN(utcInstant.getTime()) ? null : utcInstant;
}

/** Today's IST calendar date as "YYYY-MM-DD". */
export function todayISTDateStr() {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

const WEEKDAY_INDEX = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};
const WEEK_NUMBERS = ['First', 'Second', 'Third', 'Fourth', 'Last'];

/**
 * Compute the next run instant (as a UTC Date) for a campaign_schedules row.
 *
 * Handles the three schedule types:
 *  - one_time:  start_date + send_time as the single next run.
 *  - weekly:    the next selected weekday that falls on a week aligned with the
 *               repeat_interval (e.g. every 2 weeks).
 *  - monthly:   day_of_month (clamped to the month length) or an ordinal
 *               weekday rule ("Last Friday").
 *
 * All wall-clock math is done on the IST calendar date; the returned Date is the
 * absolute UTC instant, matching the scheduler's due-check semantics.
 *
 * @param {object} schedule  A campaign_schedules row (or camelCase superset).
 * @returns {Date | null}
 */
export function computeNextRun(schedule) {
  if (!schedule || !schedule.schedule_type) return null;
  const time = parseTime(schedule.send_time);
  if (!time) return null;

  const anchorStr = schedule.start_date || todayISTDateStr();
  const match = String(anchorStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const nowUtc = Date.now();

  // IST wall-clock date -> absolute UTC instant.
  const instant = (y, mo, d) => istDateTimeToUtc(
    `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    schedule.send_time
  );

  if (schedule.schedule_type === 'one_time') {
    return instant(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  if (schedule.schedule_type === 'weekly') {
    const days = Array.isArray(schedule.weekly_days)
      ? schedule.weekly_days
      : String(schedule.weekly_days || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (days.length === 0) return null;
    const selectedIdx = new Set(days.map((d) => WEEKDAY_INDEX[d]).filter((i) => i != null));
    if (selectedIdx.size === 0) return null;

    const interval = Math.max(1, Number(schedule.repeat_interval) || 1);
    const anchorDay = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const anchorEpochDays = Math.floor(anchorDay.getTime() / 86400000);

    for (let offset = 0; offset < 365; offset++) {
      const candidate = new Date((anchorEpochDays + offset) * 86400000);
      if (!selectedIdx.has(candidate.getUTCDay())) continue;
      const weeksElapsed = Math.floor(offset / 7);
      if (weeksElapsed % interval !== 0) continue;
      const next = instant(
        candidate.getUTCFullYear(),
        candidate.getUTCMonth(),
        candidate.getUTCDate()
      );
      if (next && next.getTime() >= nowUtc) return next;
    }
    return null;
  }

  if (schedule.schedule_type === 'monthly') {
    const interval = Math.max(1, Number(schedule.repeat_interval) || 1);
    let y = Number(match[1]);
    let mo = Number(match[2]) - 1;

    for (let i = 0; i < 120; i++) {
      const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let candidateDay;

      if (schedule.monthly_type === 'day_of_month') {
        candidateDay = Math.max(1, Math.min(daysInMonth, Number(schedule.day_of_month) || 1));
      } else {
        const wd = WEEKDAY_INDEX[schedule.weekday];
        const wn = WEEK_NUMBERS.indexOf(schedule.week_number);
        if (wd == null || wn === -1) return null;

        const firstWeekday = new Date(Date.UTC(y, mo, 1)).getUTCDay();
        if (wn === WEEK_NUMBERS.length - 1) {
          // "Last <weekday>" of the month.
          const lastWeekday = new Date(Date.UTC(y, mo, daysInMonth)).getUTCDay();
          candidateDay = daysInMonth - ((lastWeekday - wd + 7) % 7);
        } else {
          candidateDay = 1 + ((wd - firstWeekday + 7) % 7) + wn * 7;
        }
      }

      const next = instant(y, mo, candidateDay);
      if (next && next.getTime() >= nowUtc) return next;

      const nextMonth = new Date(Date.UTC(y, mo + interval, 1));
      y = nextMonth.getUTCFullYear();
      mo = nextMonth.getUTCMonth();
    }
    return null;
  }

  return null;
}

/**
 * Whether a scheduled campaign is due to run NOW (its scheduled instant has
 * arrived and it has not been sent yet). A campaign is due when ANY of these
 * is in the past (or present):
 *   1. The legacy one-time IST wall-clock (campaigns.schedule_date/schedule_time)
 *      — what the UI writes for one-off scheduled sends.
 *   2. campaigns.scheduled_at (absolute timestamptz) — a fallback used when the
 *      wall-clock columns are absent (e.g. recurring campaigns scheduled only
 *      through campaign_schedules).
 *   3. campaign_schedules.next_run — the stored next occurrence of a recurring
 *      (weekly/monthly) schedule. For one_time schedules in campaign_schedules,
 *      due-ness is computed from start_date + send_time.
 *
 * A campaign whose time has ALREADY passed is always due, so overdue sends are
 * picked up by the very next scheduler tick.
 *
 * @param {object} campaign A campaigns row (may carry `campaign_schedules`).
 * @param {object|null} schedule The campaign's campaign_schedules row, if any.
 * @param {number} nowMs Current epoch milliseconds.
 * @returns {boolean}
 */
export function isCampaignDue(campaign, schedule, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;

  // 1) Legacy IST wall-clock.
  const legacy = istDateTimeToUtc(campaign.schedule_date, campaign.schedule_time);
  if (legacy !== null && legacy.getTime() <= now) return true;

  // 2) Absolute scheduled_at instant.
  if (campaign.scheduled_at) {
    const at = new Date(campaign.scheduled_at).getTime();
    if (!Number.isNaN(at) && at <= now) return true;
  }

  // 3) next_batch_at for batched campaigns.
  if (campaign.next_batch_at) {
    const at = new Date(campaign.next_batch_at).getTime();
    if (!Number.isNaN(at) && at <= now) return true;
  }

  // 4) campaign_schedules row.
  if (schedule) {
    if (schedule.schedule_type === 'one_time') {
      const at = istDateTimeToUtc(schedule.start_date, schedule.send_time);
      if (at !== null && at.getTime() <= now) return true;
    } else if (schedule.schedule_type === 'weekly' || schedule.schedule_type === 'monthly') {
      let next = schedule.next_run ? new Date(schedule.next_run).getTime() : null;
      if (next === null || Number.isNaN(next)) {
        const recomputed = computeNextRun(schedule);
        next = recomputed ? recomputed.getTime() : null;
      }
      if (next !== null && next <= now) return true;
    }
  }

  return false;
}
