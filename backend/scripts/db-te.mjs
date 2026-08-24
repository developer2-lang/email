import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SID = 'c3159286-2516-4640-8672-eb70e572e308';
const { data: steps } = await supabase.from('sequence_steps').select('*').eq('sequence_id', SID).is('archived_at', null);
const st = {};
for (const s of steps || []) st[s.id] = s;

const { data: enr } = await supabase.from('sequence_enrollments').select('*').eq('sequence_id', SID);
console.log('ENROLLMENTS (exact current_step):');
for (const e of enr || []) {
  const cur = st[e.current_step_id];
  console.log(`  ${e.contact_id.slice(0,8)} status=${e.status} cur_step=${cur ? `num${cur.step_number} ${cur.parent_branch}` : e.current_step_id} next_run_at=${e.next_run_at}`);
}

const { data: logs } = await supabase.from('sequence_step_logs').select('*').eq('sequence_id', SID).order('created_at');
console.log('\nSTEP LOGS (exact step + branch):');
for (const l of logs || []) {
  const s = st[l.sequence_step_id];
  console.log(`  ${l.contact_id.slice(0,8)} step=${s ? `num${s.step_number} ${s.parent_branch} (${s.id.slice(0,8)})` : l.sequence_step_id} status=${l.status} email_log_id=${l.email_log_id} opened=${l.opened} sent_at=${l.sent_at}`);
}

console.log('\nEMAIL LOG ids:');
const { data: emails } = await supabase.from('email_logs').select('id, contact_id, status, opened, opened_at, sent_at').eq('campaign_id', '10fc5871-4ac4-4eae-b5aa-69e0b299f8bd');
for (const e of emails || []) console.log(`  ${e.id.slice(0,8)} ${e.contact_id.slice(0,8)} status=${e.status} opened=${e.opened} opened_at=${e.opened_at} sent_at=${e.sent_at}`);