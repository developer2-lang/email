import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

console.log('== sequences ==');
{
  const { data, error } = await supabase
    .from('sequences')
    .select('id, name, status, campaign_id, audience_segment, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) console.log('ERR', error.message);
  for (const s of data || []) {
    console.log(`${s.id} | ${s.name} | ${s.status} | campaign=${s.campaign_id} | ${s.audience_segment} | ${s.created_at}`);
  }
}

console.log('\n== email_logs (recent 15) ==');
{
  const { data, error } = await supabase
    .from('email_logs')
    .select('id, campaign_id, contact_id, email, status, opened, opened_at, tracking_id, sent_at')
    .order('created_at', { ascending: false })
    .limit(15);
  if (error) console.log('ERR', error.message);
  for (const l of data || []) {
    console.log(`${l.status} | ${l.email} | opened=${l.opened} | ${l.opened_at || '-'} | tracking=${(l.tracking_id || '').slice(0, 8)} | sent=${l.sent_at || '-'}`);
  }
}
