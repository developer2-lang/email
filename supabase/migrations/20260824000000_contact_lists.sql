-- ============================================================================
-- Custom Audience Lists (Contact Lists + Membership)
-- ============================================================================
-- Lets users organize contacts into manually curated lists (e.g. "March Clients",
-- "Hot Leads", "Mumbai Clients") that are SEPARATE from the database-driven
-- contact_type values (Existing Client, New Lead, ...). A contact can belong to
-- many custom lists and still keep its contact_type.
--
-- These lists automatically become available as Campaign Audience Segments. The
-- campaign recipient query resolves a custom-list segment by joining
-- contact_list_members → contacts and only emails members with a valid address.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL -> New query) or via the
-- CLI. Idempotent. No existing tables/columns are modified.

create table if not exists public.contact_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text null,
  created_at  timestamptz not null default now()
);

create table if not exists public.contact_list_members (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.contact_lists(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (list_id, contact_id)
);

create index if not exists idx_contact_list_members_list
  on public.contact_list_members(list_id);
create index if not exists idx_contact_list_members_contact
  on public.contact_list_members(contact_id);

-- Make PostgREST pick up the new tables immediately.
notify pgrst, 'reload schema';

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- The React app calls Supabase with the anon/publishable key, so the anon role
-- needs explicit access (mirrors the campaign_attachments policies). RLS is
-- enabled and opened to anon for every operation. Deleting a list cascades to
-- its membership rows (on delete cascade) but NEVER touches contacts.

alter table public.contact_lists enable row level security;
alter table public.contact_list_members enable row level security;

drop policy if exists "contact_lists select" on public.contact_lists;
drop policy if exists "contact_lists insert" on public.contact_lists;
drop policy if exists "contact_lists update" on public.contact_lists;
drop policy if exists "contact_lists delete" on public.contact_lists;
create policy "contact_lists select" on public.contact_lists for select to anon using (true);
create policy "contact_lists insert" on public.contact_lists for insert to anon with check (true);
create policy "contact_lists update" on public.contact_lists for update to anon using (true) with check (true);
create policy "contact_lists delete" on public.contact_lists for delete to anon using (true);

drop policy if exists "contact_list_members select" on public.contact_list_members;
drop policy if exists "contact_list_members insert" on public.contact_list_members;
drop policy if exists "contact_list_members delete" on public.contact_list_members;
create policy "contact_list_members select" on public.contact_list_members for select to anon using (true);
create policy "contact_list_members insert" on public.contact_list_members for insert to anon with check (true);
create policy "contact_list_members delete" on public.contact_list_members for delete to anon using (true);

-- Confirm the final shape (run this SELECT afterwards).
select 'contact_lists' as tbl, column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'contact_lists'
union all
select 'contact_list_members' as tbl, column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'contact_list_members'
order by tbl, column_name;
