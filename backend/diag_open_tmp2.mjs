import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const SEQ_ID = process.env.SEQ_ID || 'e492baf2-a485-4c69-a54f-2a0c95221724';

console.log('== sequence ==');
{
  const { data, error } = await supabase.from('sequences').select('*').eq('id', SEQ_ID).maybeSingle();
  if (error) console.log('ERR', error.message);
  console.log(JSON.stringify(data, null, 1));
}

console.log('\n== steps ==');
{
  const { data, error } = await supabase.from('sequence_steps').select('*').eq('sequence_id', SEQ_ID).order('step_number');
  if (error) console.log('ERR', error.message);
  for (const s of data || []) console.log(`${s.id} | step=${s.step_number} | parent=${s.parent_step_id || 'NULL'} | branch=${s.parent_branch} | ${s.normal_subject}`);
}

console.log('\n== enrollments ==');
{
  const { data, error } = await supabase.from('sequence_enrollments').select('*').eq('sequence_id', SEQ_ID);
  if (error) console.log('ERR', error.message);
  for (const e of data || []) console.log(`${e.contact_id} | status=${e.status} | step=${e.current_step} stepId=${e.current_step_id} | emailLogId=${e.current_email_log_id || '-'}`);
}

console.log('\n== step logs ==');
{
  const { data, error } = await supabase.from('sequence_step_logs').select('*').eq('sequence_id', SEQ_ID).order('sent_at', { ascending: false });
  if (error) console.log('ERR', error.message);
  for (const l of data || []) console.log(`step=${l.sequence_step_id} | contact=${l.contact_id} | email_log_id=${l.email_log_id || 'NULL!'} | opened=${l.opened} | sent_at=${l.sent_at}`);
}

const SEQ_CAMPAIGN = '5c7b3b0f-3246-4fc8-9ed8-db443ba4b9d3';
console.log('\n== email_logs for sequence campaign ==');
{
  const { data, error } = await supabase.from('email_logs').select('*').eq('campaign_id', SEQ_CAMPAIGN).order('created_at', { ascending: true });
  if (error) console.log('ERR', error.message);
  for (const l of data || []) console.log(`${l.id} | ${l.contact_id} | ${l.email} | status=${l.status} | opened=${l.opened} | ${l.opened_at || '-'} | tracking=${l.tracking_id || '-'}`);
}
