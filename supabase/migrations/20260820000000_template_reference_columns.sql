-- ============================================================================
-- Template reference columns (campaigns / sequence_steps / sequence_branch_steps)
-- ============================================================================
-- Campaigns and sequence steps store a COPY of the template HTML in their body
-- column, but the composer also remembers which template they were authored
-- from. These columns persist that reference (template_id) so the send path
-- can fetch the ORIGINAL HTML from the templates table / Storage at send time:
-- template edits then propagate to new sends instead of being frozen at the
-- moment the user clicked "Load Template".
--
-- Until this migration runs, the backend omits these columns automatically
-- (column-presence guard), so existing campaigns/steps keep working. After it
-- runs, newly saved campaigns/steps record the reference.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL -> New query) or via
-- the CLI. Idempotent. No existing rows are modified; the columns default to
-- NULL until the next save of each campaign/step.

alter table public.campaigns
  add column if not exists template_id uuid references public.templates(id);

alter table public.sequence_steps
  add column if not exists normal_template_id uuid references public.templates(id);

alter table public.sequence_steps
  add column if not exists increment_template_id uuid references public.templates(id);

alter table public.sequence_branch_steps
  add column if not exists template_id uuid references public.templates(id);

-- Make PostgREST pick up the new columns immediately.
notify pgrst, 'reload schema';

-- Confirm the final shape (run this SELECT afterwards).
select 'campaigns' as tbl, column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'campaigns'
    and column_name in ('template_id')
union all
select 'sequence_steps' as tbl, column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sequence_steps'
    and column_name in ('normal_template_id','increment_template_id')
union all
select 'sequence_branch_steps' as tbl, column_name
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sequence_branch_steps'
    and column_name in ('template_id')
order by tbl, column_name;