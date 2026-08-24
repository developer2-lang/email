/**
 * Follow-up attachment upload — Supabase Storage + metadata rows.
 *
 * Follow-up attachments live in the PUBLIC `followup-attachments` Storage
 * bucket (never `campaign-attachments` — that bucket is reserved for
 * Campaigns). Every file gets a UNIQUE object path:
 *
 *   followup/{followup_name}/{uniqueId}-{sanitized_file_name}
 *
 * so re-uploading the same file name never collides with an existing object
 * ("The resource already exists" is impossible). Metadata is persisted in the
 * existing `campaign_attachments` table (a follow-up campaign IS a campaign),
 * exactly like Campaigns — the send-followup Edge Function already reads
 * storage_bucket + storage_path from that table.
 *
 * Brand-new composer files (uploaded before the follow-up campaign exists) go
 * to a unique temporary path under followup/pending/ and are relocated into
 * followup/{followup_name}/... once the follow-up is created.
 */
import { supabase } from '../supabase'
import { sanitizeCampaignFolderName } from './campaignService'
import type { CampaignAttachment } from '../types/campaign'

const FOLLOWUP_ATTACHMENTS_TABLE = 'campaign_attachments'
const FOLLOWUP_ATTACHMENTS_BUCKET = 'followup-attachments'

// Same per-file ceiling the campaign attachments use (20 MB).
const MAX_ATTACHMENT_FILE_SIZE = 20 * 1024 * 1024

/** Strip characters that are unsafe in a Storage object path. */
function sanitizeStorageName(name: string): string {
  const base = String(name || 'file')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base || 'file'
}

/**
 * Temporary path used BEFORE the follow-up campaign exists:
 * `followup/pending/{UUID}-{sanitized_file_name}`.
 */
function uniquePendingPath(fileName: string): string {
  return `followup/pending/${crypto.randomUUID()}-${sanitizeStorageName(fileName)}`
}

/** Guaranteed-unique file name segment: `{UUID}-{sanitized_file_name}`. */
function uniqueFileName(fileName: string): string {
  return `${crypto.randomUUID()}-${sanitizeStorageName(fileName)}`
}

/**
 * Read the REAL campaign_name of the follow-up campaign (a follow-up IS a
 * campaign) so the permanent Storage folder uses the same canonical naming
 * convention Campaigns use (the readable campaign name as a folder).
 */
async function fetchFollowupCampaignName(followupId: string): Promise<string> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('campaign_name')
    .eq('id', followupId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the follow-up campaign for this attachment: ${error.message}`)
  if (!data || !data.campaign_name) throw new Error('Follow-up campaign has no name to use for the attachment folder.')
  return String(data.campaign_name).trim()
}

/**
 * Permanent folder for a follow-up's attachments:
 * `followup/{sanitized_followup_name}` (canonical campaign folder convention).
 */
async function resolveFollowupFolder(followupId: string): Promise<string> {
  const campaignName = await fetchFollowupCampaignName(followupId)
  return `followup/${sanitizeCampaignFolderName(campaignName)}`
}

/**
 * Relocate a Storage object within the bucket using ONLY the anon policies
 * (SELECT + INSERT + DELETE on the public bucket). storage.move() requires an
 * UPDATE policy this project does not grant, so the bytes are read back with
 * the anon SELECT policy (supabase.storage.download — works whether or not the
 * bucket is public), re-uploaded under the final unique path, and the source
 * object is removed (best-effort).
 */
async function relocateStorageObject(bucket: string, fromPath: string, toPath: string): Promise<void> {
  if (fromPath === toPath) return
  const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(fromPath)
  if (downloadError || !blob) {
    throw new Error(
      `Failed to read the uploaded file from Storage (${fromPath}): ${downloadError?.message || 'empty response'}`
    )
  }
  const { error: uploadError } = await supabase.storage.from(bucket).upload(toPath, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  })
  if (uploadError) throw new Error(`Failed to store the attachment under the follow-up folder: ${uploadError.message}`)
  const { error: removeError } = await supabase.storage.from(bucket).remove([fromPath])
  if (removeError) console.error('[Follow-up Attachment] Temp file cleanup failed:', removeError.message)
}

/**
 * Upload a file to Supabase Storage (`followup-attachments` bucket) and return
 * the attachment metadata for the Follow-up composer.
 *
 * - With a follow-up campaign id (reuse): the file uploads DIRECTLY into
 *   followup/{followup_name}/{unique}-{name}, the metadata is persisted as a
 *   `campaign_attachments` row immediately, and the real record is returned.
 * - Without an id (brand-new follow-up): the file uploads to a unique
 *   temporary path only and no DB row is written; it is relocated into
 *   followup/{followup_name}/... once the follow-up campaign is created.
 */
export async function uploadFollowupAttachment(
  file: File,
  followupId?: string | null
): Promise<CampaignAttachment> {
  if (file.size <= 0) throw new Error(`'${file.name}' is empty and cannot be uploaded.`)
  if (file.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new Error(`'${file.name}' exceeds the 20 MB per-file limit.`)
  }

  if (!followupId) {
    const path = uniquePendingPath(file.name)
    const { error } = await supabase.storage.from(FOLLOWUP_ATTACHMENTS_BUCKET).upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
    if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`)
    return {
      id: `temp-${crypto.randomUUID()}`,
      campaign_id: '',
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: FOLLOWUP_ATTACHMENTS_BUCKET,
      storage_path: path,
      persisted: false,
    }
  }

  const folder = await resolveFollowupFolder(String(followupId))
  const path = `${folder}/${uniqueFileName(file.name)}`
  const { error } = await supabase.storage.from(FOLLOWUP_ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`)

  const { data: inserted, error: dbError } = await supabase
    .from(FOLLOWUP_ATTACHMENTS_TABLE)
    .insert({
      campaign_id: String(followupId),
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: FOLLOWUP_ATTACHMENTS_BUCKET,
      storage_path: path,
    })
    .select('*')
    .single()
  if (dbError) throw new Error(`Failed to save attachment record for '${file.name}': ${dbError.message}`)

  return { ...(inserted as CampaignAttachment), persisted: true }
}

/**
 * Move a brand-new follow-up's not-yet-persisted attachments (uploaded to a
 * temporary path before the follow-up existed) into the follow-up's Storage
 * folder (followup/{followup_name}/{unique}-{name}) AND persist their metadata
 * row, returning the REAL `campaign_attachments` records so storage_path and
 * id always match the database. Attachments already persisted against a
 * follow-up (persisted !== false) are returned unchanged — existing rows are
 * never deleted/re-inserted during an edit.
 */
export async function relocatePendingFollowupAttachments(
  followupId: string,
  attachments: CampaignAttachment[]
): Promise<CampaignAttachment[]> {
  const folder = await resolveFollowupFolder(followupId)
  const result: CampaignAttachment[] = []
  for (const att of attachments) {
    if (att.persisted !== false) {
      result.push(att)
      continue
    }
    const oldPath = att.storage_path
    const newPath = `${folder}/${uniqueFileName(att.file_name)}`
    const bucket = att.storage_bucket || FOLLOWUP_ATTACHMENTS_BUCKET
    if (oldPath !== newPath) {
      await relocateStorageObject(bucket, oldPath, newPath)
      console.log(`[Follow-up Attachment] Moved ${oldPath} → ${newPath}`)
    }
    const { data: inserted, error: dbError } = await supabase
      .from(FOLLOWUP_ATTACHMENTS_TABLE)
      .insert({
        campaign_id: followupId,
        file_name: att.file_name,
        file_type: att.file_type,
        file_size: att.file_size,
        storage_bucket: bucket,
        storage_path: newPath,
      })
      .select('*')
      .single()
    if (dbError) throw new Error(`Failed to save attachment record for '${att.file_name}': ${dbError.message}`)
    result.push({ ...(inserted as CampaignAttachment), persisted: true })
  }
  return result
}