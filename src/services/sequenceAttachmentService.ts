/**
 * Sequence step attachments — Supabase Storage + metadata rows.
 *
 * Every attachment belongs to ONE sequence step (sequence_step_id). Files live
 * in the `sequence-attachments` Storage bucket under the readable layout
 * `sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/{file_name}`
 * (see sequenceAttachmentStorage.ts), and a `sequence_step_attachments` row
 * keeps the metadata so the sequence_steps table never stores file bytes. The
 * stored `storage_path` always equals the real object path; legacy UUID-only
 * uploads keep their old paths and stay downloadable.
 *
 * Flow: composer uploads → Storage + metadata row (existing steps) OR temp
 * Storage path only (brand-new steps, persisted=false) → on save the temp
 * files are relocated into the step's folder and their metadata rows inserted.
 * The senders (sequence-runner / sequence-manual-send) read the rows for the
 * exact step being sent and attach those files to that step's email only.
 */
import { supabase } from '../supabase';
import type { SequenceAttachment } from '../types/sequence';
import {
  SEQUENCE_ATTACHMENTS_BUCKET,
  fetchStepFolder,
} from './sequenceAttachmentStorage';

const SEQUENCE_STEP_ATTACHMENTS_TABLE = 'sequence_step_attachments';

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
  if (uploadError) throw new Error(`Failed to store the attachment under the step folder: ${uploadError.message}`);
  const { error: removeError } = await supabase.storage.from(bucket).remove([fromPath]);
  if (removeError) console.error('[Sequence Attachment] Temp file cleanup failed:', removeError.message);
}

/**
 * Move a brand-new step's not-yet-persisted attachments (uploaded to a
 * temporary path before the step existed) into the step's Storage folder
 * (`sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/`)
 * so storage_path always matches the real object location. Attachments already
 * persisted under a step (persisted !== false) are returned unchanged.
 */
export async function relocatePendingStepAttachments(
  sequenceId: string,
  stepId: string,
  attachments: SequenceAttachment[]
): Promise<SequenceAttachment[]> {
  const { folder } = await fetchStepFolder(sequenceId, stepId);
  const result: SequenceAttachment[] = [];
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
      console.log(`[Sequence Attachment] Moved ${oldPath} → ${newPath}`);
    }
    const { data: inserted, error: dbError } = await supabase
      .from(SEQUENCE_STEP_ATTACHMENTS_TABLE)
      .insert({
        sequence_step_id: stepId,
        file_name: att.file_name,
        file_type: att.file_type,
        file_size: att.file_size,
        storage_bucket: bucket,
        storage_path: newPath,
      })
      .select('*')
      .single();
    if (dbError) throw new Error(`Failed to save attachment record for '${att.file_name}': ${dbError.message}`);
    result.push({ ...(inserted as SequenceAttachment), persisted: true });
  }
  return result;
}

/**
 * Upload a file to Supabase Storage (`sequence-attachments` bucket) and return
 * the attachment metadata for the composer.
 *
 * - With an existing `stepId`: the sequence name + id are read from the real
 *   `sequences` record and the step's number + branch from its `sequence_steps`
 *   row, then the file is uploaded DIRECTLY into
 *   `sequence-attachments/{sequence_name}__{sequence_id}/step-{n}-{branch}/{file_name}`,
 *   the metadata is persisted as a `sequence_step_attachments` row immediately,
 *   and the REAL database record is returned (persisted=true).
 * - Without a step id (brand-new step in the composer): the file is uploaded to
 *   a temporary `pending/` path only; no `sequence_step_attachments` row is
 *   created yet. A temporary record (sequence_step_id = '', persisted = false)
 *   is kept in composer state and relocated into the step's folder once the
 *   step and its sequence exist.
 *
 * The file name is sanitized so collisions are impossible and the binary is
 * never stored in the sequence_steps table.
 */
export async function uploadStepAttachment(
  file: File,
  sequenceId?: string | null,
  stepId?: string | null
): Promise<SequenceAttachment> {
  if (file.size <= 0) throw new Error(`'${file.name}' is empty and cannot be uploaded.`);
  if (file.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new Error(`'${file.name}' exceeds the 20 MB per-file limit.`);
  }

  const fileName = sanitizeStorageName(file.name);

  // Brand-new step (no step id yet): upload to a temporary path and keep the
  // metadata in composer state. No metadata row is created — the file is moved
  // into the step's folder once the step and its sequence are saved.
  if (!stepId) {
    const path = `pending/${crypto.randomUUID()}/${fileName}`;
    const { error } = await supabase.storage.from(SEQUENCE_ATTACHMENTS_BUCKET).upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`);
    console.log(`[Sequence Attachment] Upload successful: ${SEQUENCE_ATTACHMENTS_BUCKET}/${path}`);
    console.log(`[Sequence Attachment] No step yet — keeping '${file.name}' in temporary composer state.`);
    return {
      id: `temp-${crypto.randomUUID()}`,
      sequence_step_id: '',
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: SEQUENCE_ATTACHMENTS_BUCKET,
      storage_path: path,
      persisted: false,
    };
  }

  if (!sequenceId) {
    throw new Error('A sequence id is required to upload an attachment to a saved step.');
  }

  // Existing step: resolve the real sequence name/id + step number/branch from
  // the database, upload directly into the step's folder and persist the
  // metadata row with the real sequence_step_id / storage_bucket / storage_path.
  const { folder } = await fetchStepFolder(sequenceId, String(stepId));
  const path = `${folder}/${fileName}`;
  const { error } = await supabase.storage.from(SEQUENCE_ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`);
  console.log(`[Sequence Attachment] Upload successful: ${SEQUENCE_ATTACHMENTS_BUCKET}/${path}`);

  const { data: inserted, error: dbError } = await supabase
    .from(SEQUENCE_STEP_ATTACHMENTS_TABLE)
    .insert({
      sequence_step_id: String(stepId),
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: SEQUENCE_ATTACHMENTS_BUCKET,
      storage_path: path,
    })
    .select('*')
    .single();
  if (dbError) throw new Error(`Failed to save attachment record for '${file.name}': ${dbError.message}`);
  console.log(`[Sequence Attachment] DB record created: ${inserted.id} for step ${stepId}`);

  return { ...(inserted as SequenceAttachment), persisted: true };
}

/** Fetch the attachment metadata rows saved against one sequence step. */
export async function fetchStepAttachments(
  stepId: string
): Promise<{ data: SequenceAttachment[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(SEQUENCE_STEP_ATTACHMENTS_TABLE)
      .select('*')
      .eq('sequence_step_id', stepId)
      .order('created_at', { ascending: true });
    if (error) return { data: [], error: error.message };
    return { data: (data as SequenceAttachment[] | null) ?? [], error: null };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch attachments' };
  }
}

/**
 * Remove an attachment: deletes the Storage object (best-effort — it may
 * already be gone) and, when the file was persisted against a step, its
 * metadata row.
 */
export async function removeStepAttachment(
  attachment: SequenceAttachment
): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage
    .from(attachment.storage_bucket || SEQUENCE_ATTACHMENTS_BUCKET)
    .remove([attachment.storage_path]);
  if (storageError) {
    console.error('Attachment storage removal failed:', storageError.message);
  }

  if (attachment.sequence_step_id && attachment.id) {
    const { error: dbError } = await supabase
      .from(SEQUENCE_STEP_ATTACHMENTS_TABLE)
      .delete()
      .eq('id', attachment.id);
    if (dbError) return { error: `Failed to remove attachment: ${dbError.message}` };
  }
  return { error: null };
}