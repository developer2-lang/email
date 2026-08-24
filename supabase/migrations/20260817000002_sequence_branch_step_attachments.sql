-- ============================================================================
-- Sequence Builder branch-step attachments — Supabase Storage + metadata table
-- ============================================================================
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query), or via
-- the CLI. Adds the `sequence_branch_step_attachments` table that stores
-- attachment METADATA (never the file bytes) for attachments made from the
-- Sequence Builder → Edit modal.
--
-- Every attachment belongs to ONE sequence_branch_steps row
-- (sequence_branch_step_attachments.branch_step_id) so OPENED and NOT_OPENED
-- branches keep fully independent file lists. Files live in the EXISTING
-- `sequence-attachments` Storage bucket under
-- `sequence-attachments/branch-steps/{branch_step_id}/{file_name}`.
--
-- The senders (sequence-runner / sequence-manual-send / sequence worker) read
-- the rows for the EXACT branch step being sent and attach those files to that
-- branch's email only — files from other steps are never attached.
--
-- Additive only — does NOT touch existing sequences / branch steps / steps /
-- enrollments or the existing sequence_step_attachments / campaign_attachments.
-- Safe to run once; every statement is idempotent.

-- 1) Attachments metadata table. storage_path uses the id-based layout
--    `branch-steps/{branch_step_id}/{file_name}` so branch edits / renames
--    never break existing files.
create table if not exists public.sequence_branch_step_attachments (
  id             bigserial primary key,
  branch_step_id bigint not null references public.sequence_branch_steps (id) on delete cascade,
  file_name      text not null,
  file_size      bigint,
  storage_bucket text not null default 'sequence-attachments',
  storage_path   text not null,
  created_at     timestamptz not null default now()
);

create index if not exists sequence_branch_step_attachments_step_idx
  on public.sequence_branch_step_attachments (branch_step_id);

-- 2) Storage bucket: the `sequence-attachments` bucket already exists (created
--    by the sequence_step_attachments migration) — never create a duplicate.
--    Storage policies for that bucket already allow the anon role to
--    insert/select/delete, so no new Storage policy is required. They are
--    re-declared below idempotently only for safety/self-containment.

-- 3) Storage access for the anon/publishable key used by the browser
--    (idempotent re-declaration of the existing sequence-attachments policies).
drop policy if exists "sequence attachments insert" on storage.objects;
create policy "sequence attachments insert"
  on storage.objects for insert to anon
  with check (bucket_id = 'sequence-attachments');

drop policy if exists "sequence attachments read" on storage.objects;
create policy "sequence attachments read"
  on storage.objects for select to anon
  using (bucket_id = 'sequence-attachments');

drop policy if exists "sequence attachments delete" on storage.objects;
create policy "sequence attachments delete"
  on storage.objects for delete to anon
  using (bucket_id = 'sequence-attachments');

-- 4) Table-level access for the anon/publishable key used by the browser
--    (the app has no Supabase Auth users, so all requests are the anon role).
alter table public.sequence_branch_step_attachments enable row level security;

drop policy if exists "sequence branch attachments select" on public.sequence_branch_step_attachments;
create policy "sequence branch attachments select"
  on public.sequence_branch_step_attachments for select to anon
  using (true);

drop policy if exists "sequence branch attachments insert" on public.sequence_branch_step_attachments;
create policy "sequence branch attachments insert"
  on public.sequence_branch_step_attachments for insert to anon
  with check (true);

drop policy if exists "sequence branch attachments delete" on public.sequence_branch_step_attachments;
create policy "sequence branch attachments delete"
  on public.sequence_branch_step_attachments for delete to anon
  using (true);

-- Confirm the table shape.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'sequence_branch_step_attachments'
order by ordinal_position;
