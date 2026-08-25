/**
 * Shared batch / throttled-sending helpers.
 *
 * Pure, environment-agnostic utilities (no Deno / Node / browser APIs except
 * Date) used by BOTH campaign Edge Functions so the batch math and the
 * next-batch scheduling can never drift between scheduled-campaign-runner and
 * send-campaign.
 *
 * See the product spec: a campaign resolves its audience FIRST, then splits the
 * resolved recipient list into stable, deterministic batches of `batch_size`,
 * sending one batch per worker run and waiting `batch_interval_minutes` before
 * the next. A recipient is emailed at most once because each contact owns a
 * single email_logs row (the batch claim only ever selects rows still in
 * 'pending').
 */

// IST (Asia/Kolkata) = UTC+05:30. Mirrors the offset used by the schedulers so
// the next-batch wall-clock time is computed the same way everywhere.


const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Split a resolved recipient count into deterministic batch sizes.
 *
 *   computeBatchSizes(500, 30) -> [30,30,...,30,20]  (17 entries)
 *   computeBatchSizes(60, 30)  -> [30,30]            (2 entries)
 *   computeBatchSizes(20, 30)  -> [20]              (1 entry, no empty batch)
 *   computeBatchSizes(75, 30)  -> [30,30,15]        (3 entries)
 *   computeBatchSizes(70, 30)  -> [30,30,10]        (3 entries)
 *
 * An empty audience yields an empty array (the caller must NOT create batches).
 */
export function computeBatchSizes(total: number, batchSize: number): number[] {
  const size = Math.max(1, Math.floor(Number(batchSize)) || 30);
  const safeTotal = Math.max(0, Math.floor(Number(total)) || 0);
  if (safeTotal <= 0) return [];
  const sizes: number[] = [];
  let remaining = safeTotal;
  while (remaining > 0) {
    const s = Math.min(size, remaining);
    sizes.push(s);
    remaining -= s;
  }
  return sizes;
}

/** Number of batches required for `total` recipients at `batchSize`. */
export function computeTotalBatches(total: number, batchSize: number): number {
  return computeBatchSizes(total, batchSize).length;
}

/** Convert a UTC epoch-ms instant into the IST wall-clock date (YYYY-MM-DD). */
export function utcToIstDateStr(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Convert a UTC epoch-ms instant into the IST wall-clock time (HH:MM, 24h). */
export function utcToIstTimeStr(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * Atomically claim up to `batchSize` PENDING email_logs for a campaign, marking
 * them 'sending' so a concurrent worker can never claim the same rows. The claim
 * is ordered by contact_id (asc) which gives a STABLE, deterministic recipient
 * ordering — the same contact is never pulled into two batches.
 *
 * `batchNumber` is written onto every claimed row (email_logs.batch_number) so
 * the send can be audited per-batch. Recipients already 'sent'/'failed' are
 * never selected (the WHERE clause pins status='pending'), which is what
 * guarantees no contact is mailed twice.
 */
export async function claimPendingLogsLimited(
  supabase: any,
  campaignId: string,
  batchNumber: number,
  batchSize: number
): Promise<any[]> {
  const nowIso = new Date().toISOString();
  const { data: pending, error: selErr } = await supabase
    .from('email_logs')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
    .order('contact_id', { ascending: true })
    .limit(batchSize);
  if (selErr) throw new Error(`Failed to fetch pending logs: ${selErr.message}`);
  if (!pending || pending.length === 0) return [];
  const ids = (pending as any[]).map((p) => p.id);
  const { data: claimed, error: updErr } = await supabase
    .from('email_logs')
    .update({ status: 'sending', last_attempt_at: nowIso, batch_number: batchNumber })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*');
  if (updErr) throw new Error(`Failed to claim pending logs: ${updErr.message}`);
  return claimed || [];
}
