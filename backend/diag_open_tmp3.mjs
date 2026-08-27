import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const emails = [
  'ratnasantara1@gmail.com',
  'roshnisantara1@gmail.com',
  'roshnisantara7@gmail.com',
  'ratnasantara76@gmail.com',
  'santararajan97@gmail.com',
  'developer2@iuova.in',
];

console.log('== contacts for these emails ==');
const { data: contacts, error: cErr } = await supabase
  .from('contacts')
  .select('id, email, full_name, contact_type')
  .in('email', emails);
if (cErr) console.log('ERR', cErr.message);
for (const c of contacts || []) console.log(`${c.id} | ${c.email} | ${c.full_name} | ${c.contact_type}`);

console.log('\n== ALL email_logs for these contact emails ==');
const { data: logs, error: lErr } = await supabase
  .from('email_logs')
  .select('id, campaign_id, contact_id, email, status, opened, opened_at, sent_at, tracking_id, created_at')
  .in('email', emails)
  .order('sent_at', { ascending: true });
if (lErr) console.log('ERR', lErr.message);
for (const l of logs || []) {
  console.log(`${l.sent_at || 'no-sent'} | ${l.email} | camp=${(l.campaign_id || '').slice(0, 8)} | opened=${l.opened} | ${l.opened_at || ''} | status=${l.status}`);
}

console.log('\n== campaigns (recent) ==');
const { data: camps, error: campErr } = await supabase
  .from('campaigns')
  .select('id, campaign_name, campaign_type, status, created_at')
  .order('created_at', { ascending: false })
  .limit(15);
if (campErr) console.log('ERR', campErr.message);
for (const c of camps || []) console.log(`${c.id} | ${c.campaign_name} | ${c.campaign_type} | ${c.status} | ${c.created_at}`);
