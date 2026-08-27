-- ============================================================================
-- Follow-up attachments — anon Storage access for the existing
-- `followup-attachments` bucket
-- ============================================================================
-- The PUBLIC `followup-attachments` bucket already exists in the project (it
-- was created from the Dashboard) and currently has 0 policies, so the browser
-- cannot upload/download files into it. Follow-up attachments are uploaded from
-- the browser using the anon/publishable key (the app has no Supabase Auth
-- users — all requests are the anon role), so it needs the SAME anon-role
-- Storage access the `campaign-attachments` bucket already has:
--
--   INSERT  → uploadFollowupAttachment / relocation re-upload
--   SELECT  → read/download (used by the client relocation read + senders)
--   DELETE  → removeFollowupAttachment
--
-- No UPDATE policy is added on purpose: relocation reads the bytes back with
-- the SELECT policy (supabase.storage.download) and re-uploads under a fresh
-- unique path instead of using storage.move() (which would need an UPDATE
-- policy).
--
-- This migration deliberately does NOT create the bucket — it already exists.
-- It only adds the Storage policies. Idempotent: re-running it is safe.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query), or via
-- the CLI.
drop policy if exists "followup attachments insert" on storage.objects;
create policy "followup attachments insert"
  on storage.objects for insert to anon
  with check (bucket_id = 'followup-attachments');

drop policy if exists "followup attachments read" on storage.objects;
create policy "followup attachments read"
  on storage.objects for select to anon
  using (bucket_id = 'followup-attachments');

drop policy if exists "followup attachments delete" on storage.objects;
create policy "followup attachments delete"
  on storage.objects for delete to anon
  using (bucket_id = 'followup-attachments');