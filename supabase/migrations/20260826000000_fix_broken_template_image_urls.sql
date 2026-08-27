-- ============================================================================
-- Fix broken image URLs in templates.body
-- ============================================================================
-- The 'Template' template was imported from Mailchimp and contains
-- mcusercontent.com / dim.mcusercontent.com image URLs that now return
-- 403/404. These images have already been uploaded to the 'email template'
-- Storage bucket. This migration replaces the broken URLs with the correct
-- Supabase Storage public URLs.
--
-- Run in the Supabase SQL editor or via CLI. Idempotent — safe to re-run.

-- Storage base URL for 'email template' bucket images
-- (Supabase Storage public URL format)
-- SELECT storage_url FROM (VALUES
--   ('.../object/public/email%20template/images/...')

-- 1) Banner / header image (dim.mcusercontent.com — 404)
update public.templates
set body = replace(
  body,
  'https://dim.mcusercontent.com/cs/dd402479fe7ccc7f2368df88d/images/bd92a65e-d695-3e45-ff13-1db600fa2d42.png?dpr=2&amp;rect=0%2C2304%2C8592%2C3189&amp;w=660&amp;h=245',
  'https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/email%20template/images/1787132745709-12c51e99-a810-4177-a6eb-e786c09414b5.png'
),
updated_at = now()
where body like '%dim.mcusercontent.com%bd92a65e%';

-- 2) Hero / product image (mcusercontent.com — 403)
update public.templates
set body = replace(
  body,
  'https://mcusercontent.com/dd402479fe7ccc7f2368df88d/images/cb81ce7c-f511-f4fe-b1f4-61d40d079f8d.png',
  'https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/email%20template/images/1787132938768-8e65639a-9623-47f8-971c-e5ca9c664a87.png'
),
updated_at = now()
where body like '%mcusercontent.com%cb81ce7c%';

-- 3) Small product icon 1 (mcusercontent.com — 403)
update public.templates
set body = replace(
  body,
  'https://mcusercontent.com/dd402479fe7ccc7f2368df88d/images/49537ed3-8501-6626-0d3e-aefa05a29744.png',
  'https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/email%20template/images/1787133144108-64cea352-9900-4ce5-8b05-c298190f33f5.jpg'
),
updated_at = now()
where body like '%mcusercontent.com%49537ed3%';

-- 4) Small product icon 2 (mcusercontent.com — 403)
update public.templates
set body = replace(
  body,
  'https://mcusercontent.com/dd402479fe7ccc7f2368df88d/images/687b83d2-1acb-bc04-3e8a-ced6c1d02748.png',
  'https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/email%20template/images/1787158141897-75872154-a880-4b14-b4c3-2ec4846a2629.jpg'
),
updated_at = now()
where body like '%mcusercontent.com%687b83d2%';

-- 5) Small avatar / icon (dim.mcusercontent.com — 404)
update public.templates
set body = replace(
  body,
  'https://dim.mcusercontent.com/cs/dd402479fe7ccc7f2368df88d/images/a39d5db0-8804-dfe6-61f0-0da573a39a23.png?dpr=2&amp;rect=183%2C0%2C694%2C957&amp;w=68&amp;h=93',
  'https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/email%20template/images/1787200994235-4fae3afb-f916-4950-8f3b-7bb0a1a34745.jpg'
),
updated_at = now()
where body like '%dim.mcusercontent.com%a39d5db0%';

-- Verify: no mcusercontent URLs should remain in any template body
select
  id,
  name,
  (length(body) - length(replace(body, 'mcusercontent.com', ''))) / length('mcusercontent.com') as mc_url_count
from public.templates
where body like '%mcusercontent.com%';

-- Make PostgREST pick up updated rows
notify pgrst, 'reload schema';
