-- ============================================================================
-- Campaign attachments — Supabase Storage + metadata table
-- ============================================================================
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query), or via
-- the CLI. Adds the `campaign_attachments` table that stores attachment
-- METADATA (never the file bytes) and creates the `campaign-attachments`
-- Storage bucket where the files actually live.
--
-- Flow: Campaign composer → upload file to Storage → row in
-- campaign_attachments → send-campaign / scheduled-campaign-runner read the
-- rows, download the files from Storage, and attach them to each MIME message.
--
-- Additive only — does NOT touch existing campaigns / templates / schedules.

-- 1) Attachments metadata table.
create table if not exists public.campaign_attachments (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.campaigns (id) on delete cascade,
  file_name      text not null,
  file_type      text not null default 'application/octet-stream',
  file_size      bigint not null default 0,
  storage_bucket text not null default 'campaign-attachments',
  storage_path   text not null,
  created_at     timestamptz not null default now()
);

create index if not exists campaign_attachments_campaign_idx
  on public.campaign_attachments (campaign_id);

-- 2) Storage bucket for the uploaded files. Public so the browser can read
--    files back; the Edge Functions read them with the service role regardless.
insert into storage.buckets (id, name, public)
values ('campaign-attachments', 'campaign-attachments', true)
on conflict (id) do nothing;

-- 3) Storage access for the anon/publishable key used by the browser.
drop policy if exists "campaign attachments insert" on storage.objects;
create policy "campaign attachments insert"
  on storage.objects for insert to anon
  with check (bucket_id = 'campaign-attachments');

drop policy if exists "campaign attachments read" on storage.objects;
create policy "campaign attachments read"
  on storage.objects for select to anon
  using (bucket_id = 'campaign-attachments');

drop policy if exists "campaign attachments delete" on storage.objects;
create policy "campaign attachments delete"
  on storage.objects for delete to anon
  using (bucket_id = 'campaign-attachments');

-- 4) Table-level access for the anon/publishable key used by the browser
--    (the app has no Supabase Auth users, so all requests are the anon role).
alter table public.campaign_attachments enable row level security;

drop policy if exists "campaign attachments select" on public.campaign_attachments;
create policy "campaign attachments select"
  on public.campaign_attachments for select to anon
  using (true);

drop policy if exists "campaign attachments insert" on public.campaign_attachments;
create policy "campaign attachments insert"
  on public.campaign_attachments for insert to anon
  with check (true);

drop policy if exists "campaign attachments delete" on public.campaign_attachments;
create policy "campaign attachments delete"
  on public.campaign_attachments for delete to anon
  using (true);

-- Confirm the table shape.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'campaign_attachments'
order by ordinal_position;
