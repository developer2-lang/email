/**
 * Sequence Builder branch-step attachments — Supabase Storage + metadata rows.
 *
 * Every attachment belongs to ONE `sequence_branch_steps` row
 * (sequence_branch_step_attachments.branch_step_id) so OPENED and NOT_OPENED
 * branches keep fully independent file lists. Files live in the EXISTING
 * `sequence-attachments` Storage bucket under the readable layout
 * `sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/{file_name}`
 * (see sequenceAttachmentStorage.ts), keyed by the branch row's step number +
 * parent branch. The stored `storage_path` always equals the real object path;
 * legacy UUID-only uploads keep their old paths and stay downloadable.
 *
 * Flow: builder uploads → Storage + metadata row (existing branch steps) OR
 * temp Storage path only (brand-new branch steps, persisted=false) → on save
 * the temp files are relocated into the branch step's folder and their metadata
 * rows inserted. The senders (sequence-runner / sequence-manual-send / the
 * sequence worker) read the rows for the exact branch step being sent and
 * attach those files to that branch's email only.
 */
import { supabase } from '../supabase';
import type { SequenceBranchStepAttachment } from '../types/sequence';
import {
  SEQUENCE_ATTACHMENTS_BUCKET,
  fetchBranchStepFolder,
} from './sequenceAttachmentStorage';

const BRANCH_STEP_ATTACHMENTS_TABLE = 'sequence_branch_step_attachments';

// Gmail's practical message size limit is ~25 MB total; keep a single file at
// 20 MB so the base64 overhead still fits inside one email.
const MAX_ATTACHMENT_FILE_SIZE = 20 * 1024 * 1024;

/** Human-readable file size, e.g. 1432 → "1.4 KB", 2048576 → "2 MB". */
export function formatFileSize(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / Math.pow(1024, unit);
  const text = unit === 0 || scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * Strip characters that are unsafe in a Storage object path (slash, quotes,
 * control chars) and transliterate accents so file names stay filesystem- and
 * URL-friendly. Always falls back to a plain, non-empty name.
 */
function sanitizeStorageName(name: string): string {
  const base = String(name || 'file')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return base || 'file';
}

/**
 * Relocate a Storage object within a bucket using ONLY the existing anon
 * policies (SELECT on the public bucket + INSERT + DELETE). The Storage `move()`
 * API requires an UPDATE policy, which this project does not grant to the anon
 * role, so the bytes are read from the object's public URL, re-uploaded under
 * the final path, and the source is removed (best-effort cleanup).
 */
async function relocateStorageObject(bucket: string, fromPath: string, toPath: string): Promise<void> {
  if (fromPath === toPath) return;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fromPath);
  if (!urlData?.publicUrl) throw new Error(`Could not resolve the uploaded file URL (${fromPath}).`);
  const response = await fetch(urlData.publicUrl);
  if (!response.ok) throw new Error(`Failed to read the uploaded file from Storage (HTTP ${response.status}).`);
  const blob = await response.blob();
  const { error: uploadError } = await supabase.storage.from(bucket).upload(toPath, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploadError) throw new Error(`Failed to store the attachment under the branch step folder: ${uploadError.message}`);
  const { error: removeError } = await supabase.storage.from(bucket).remove([fromPath]);
  if (removeError) console.error('[Branch Step Attachment] Temp file cleanup failed:', removeError.message);
}

/**
 * Move a brand-new branch step's not-yet-persisted attachments (uploaded to a
 * temporary path before the step existed) into the step's Storage folder
 * (`sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/`) so
 * storage_path always matches the real object location, and insert their
 * metadata rows. Attachments already persisted under a branch step
 * (persisted !== false) are returned unchanged.
 */
export async function relocatePendingBranchStepAttachments(
  branchStepId: number,
  attachments: SequenceBranchStepAttachment[],
): Promise<SequenceBranchStepAttachment[]> {
  const { folder } = await fetchBranchStepFolder(branchStepId);
  const result: SequenceBranchStepAttachment[] = [];
  for (const att of attachments) {
    if (att.persisted !== false) {
      result.push(att);
      continue;
    }
    const oldPath = att.storage_path;
    const fileName = oldPath.split('/').pop() || sanitizeStorageName(att.file_name);
    const newPath = `${folder}/${fileName}`;
    const bucket = att.storage_bucket || SEQUENCE_ATTACHMENTS_BUCKET;
    if (oldPath !== newPath) {
      await relocateStorageObject(bucket, oldPath, newPath);
      console.log(`[Branch Step Attachment] Moved ${oldPath} → ${newPath}`);
    }
    const { data: inserted, error: dbError } = await supabase
      .from(BRANCH_STEP_ATTACHMENTS_TABLE)
      .insert({
        branch_step_id: branchStepId,
        file_name: att.file_name,
        file_size: att.file_size,
        storage_bucket: bucket,
        storage_path: newPath,
      })
      .select('*')
      .single();
    if (dbError) throw new Error(`Failed to save attachment record for '${att.file_name}': ${dbError.message}`);
    result.push({ ...(inserted as SequenceBranchStepAttachment), persisted: true });
  }
  return result;
}

/**
 * Upload a file to Supabase Storage (`sequence-attachments` bucket) and return
 * the attachment metadata for the builder.
 *
 * - With an existing `branchStepId`: the branch step's sequence id + step
 *   number + parent branch are read from its `sequence_branch_steps` row and
 *   the sequence name + id from the real `sequences` record, then the file is
 *   uploaded DIRECTLY into
 *   `sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/{file_name}`,
 *   the metadata is persisted as a `sequence_branch_step_attachments` row
 *   immediately, and the REAL database record is returned (persisted=true).
 * - Without a branch step id (brand-new step in the builder): the file is
 *   uploaded to a temporary `pending/` path only; no DB row is created yet. A
 *   temporary record (branch_step_id = 0, persisted = false) is kept in builder
 *   state and relocated once the branch step is saved.
 *
 * The file name is sanitized so collisions are impossible and the binary is
 * never stored in the sequence_branch_steps table.
 */
export async function uploadBranchStepAttachment(
  file: File,
  branchStepId?: number | null,
): Promise<SequenceBranchStepAttachment> {
  if (file.size <= 0) throw new Error(`'${file.name}' is empty and cannot be uploaded.`);
  if (file.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new Error(`'${file.name}' exceeds the 20 MB per-file limit.`);
  }

  const fileName = sanitizeStorageName(file.name);

  // Brand-new branch step (no id yet): upload to a temporary path and keep the
  // metadata in builder state. No metadata row is created — the file is moved
  // into the step's folder once the branch step is saved.
  if (!branchStepId) {
    const path = `pending/${crypto.randomUUID()}/${fileName}`;
    const { error } = await supabase.storage.from(SEQUENCE_ATTACHMENTS_BUCKET).upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`);
    console.log(`[Branch Step Attachment] Upload successful: ${SEQUENCE_ATTACHMENTS_BUCKET}/${path}`);
    console.log(`[Branch Step Attachment] No branch step yet — keeping '${file.name}' in temporary builder state.`);
    return {
      id: 0,
      branch_step_id: 0,
      file_name: file.name,
      file_size: file.size,
      storage_bucket: SEQUENCE_ATTACHMENTS_BUCKET,
      storage_path: path,
      created_at: new Date().toISOString(),
      persisted: false,
    };
  }

  // Existing branch step: resolve the sequence + step folder from the database,
  // upload directly into the step's folder and persist the metadata row with
  // the real branch_step_id / storage_bucket / storage_path.
  const { folder } = await fetchBranchStepFolder(Number(branchStepId));
  const path = `${folder}/${fileName}`;
  const { error } = await supabase.storage.from(SEQUENCE_ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`);
  console.log(`[Branch Step Attachment] Upload successful: ${SEQUENCE_ATTACHMENTS_BUCKET}/${path}`);

  const { data: inserted, error: dbError } = await supabase
    .from(BRANCH_STEP_ATTACHMENTS_TABLE)
    .insert({
      branch_step_id: branchStepId,
      file_name: file.name,
      file_size: file.size,
      storage_bucket: SEQUENCE_ATTACHMENTS_BUCKET,
      storage_path: path,
    })
    .select('*')
    .single();
  if (dbError) throw new Error(`Failed to save attachment record for '${file.name}': ${dbError.message}`);
  console.log(`[Branch Step Attachment] DB record created: ${inserted.id} for branch step ${branchStepId}`);

  return { ...(inserted as SequenceBranchStepAttachment), persisted: true };
}

/** Fetch the attachment metadata rows saved against one sequence branch step. */
export async function fetchBranchStepAttachments(
  branchStepId: number,
): Promise<{ data: SequenceBranchStepAttachment[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(BRANCH_STEP_ATTACHMENTS_TABLE)
      .select('*')
      .eq('branch_step_id', branchStepId)
      .order('created_at', { ascending: true });
    if (error) return { data: [], error: error.message };
    return { data: (data as SequenceBranchStepAttachment[] | null) ?? [], error: null };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch attachments' };
  }
}

/**
 * Remove an attachment: deletes the Storage object (best-effort — it may
 * already be gone) and, when the file was persisted against a branch step, its
 * metadata row. Only the given attachment is removed — files belonging to other
 * branch steps are never touched.
 */
export async function removeBranchStepAttachment(
  attachment: SequenceBranchStepAttachment,
): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage
    .from(attachment.storage_bucket || SEQUENCE_ATTACHMENTS_BUCKET)
    .remove([attachment.storage_path]);
  if (storageError) {
    console.error('Branch step attachment storage removal failed:', storageError.message);
  }

  if (attachment.id && attachment.branch_step_id) {
    const { error: dbError } = await supabase
      .from(BRANCH_STEP_ATTACHMENTS_TABLE)
      .delete()
      .eq('id', attachment.id);
    if (dbError) return { error: `Failed to remove attachment: ${dbError.message}` };
  }
  return { error: null };
}
