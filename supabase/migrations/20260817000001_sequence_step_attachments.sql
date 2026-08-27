-- ============================================================================
-- Sequence step attachments — Supabase Storage + metadata table
-- ============================================================================
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query), or via
-- the CLI. Adds the `sequence_step_attachments` table that stores attachment
-- METADATA (never the file bytes) and creates the `sequence-attachments`
-- Storage bucket where the files actually live.
--
-- Flow: Sequence composer → upload file to Storage → row in
-- sequence_step_attachments (keyed by sequence_step_id) → sequence-runner /
-- sequence-manual-send read the rows for the step being sent, download the
-- files from Storage, and attach them to that step's MIME message.
--
-- Attachments belong to INDIVIDUAL steps (sequence_step_id), never to the
-- whole sequence: Step 2's files are only ever attached to Step 2's email.
--
-- Additive only — does NOT touch existing sequences / steps / enrollments.

-- 1) Attachments metadata table. storage_path uses the id-based layout
--    `sequence-attachments/{sequence_id}/{sequence_step_id}/{file_name}` so
--    step renames never break existing files.
create table if not exists public.sequence_step_attachments (
  id                uuid primary key default gen_random_uuid(),
  sequence_step_id  uuid not null references public.sequence_steps (id) on delete cascade,
  file_name         text not null,
  file_type         text not null default 'application/octet-stream',
  file_size         bigint not null default 0,
  storage_bucket    text not null default 'sequence-attachments',
  storage_path      text not null,
  created_at        timestamptz not null default now()
);

create index if not exists sequence_step_attachments_step_idx
  on public.sequence_step_attachments (sequence_step_id);

-- 2) Storage bucket for the uploaded files. Public so the browser can read
--    files back; the Edge Functions read them with the service role regardless.
insert into storage.buckets (id, name, public)
values ('sequence-attachments', 'sequence-attachments', true)
on conflict (id) do nothing;

-- 3) Storage access for the anon/publishable key used by the browser.
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
alter table public.sequence_step_attachments enable row level security;

drop policy if exists "sequence attachments select" on public.sequence_step_attachments;
create policy "sequence attachments select"
  on public.sequence_step_attachments for select to anon
  using (true);

drop policy if exists "sequence attachments insert" on public.sequence_step_attachments;
create policy "sequence attachments insert"
  on public.sequence_step_attachments for insert to anon
  with check (true);

drop policy if exists "sequence attachments delete" on public.sequence_step_attachments;
create policy "sequence attachments delete"
  on public.sequence_step_attachments for delete to anon
  using (true);

-- Confirm the table shape.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'sequence_step_attachments'
order by ordinal_position;