import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: seqs } = await supabase.from('sequences').select('*').eq('status', 'active');
console.log('=== ACTIVE SEQUENCES ===');
for (const s of seqs || []) {
  console.log(`seq ${s.id} "${s.name}" send_mode=${s.send_mode} campaign_id=${s.campaign_id}`);
}

for (const s of (seqs || [])) {
  console.log(`\n========== SEQUENCE ${s.id} "${s.name}" ==========`);
  const { data: steps } = await supabase.from('sequence_steps').select('*').eq('sequence_id', s.id).is('archived_at', null).order('step_number');
  console.log('STEPS:');
  for (const st of steps || []) {
    console.log(`  ${st.id} num=${st.step_number} wait=${st.wait_hours} parent=${st.parent_step_id ? st.parent_step_id.slice(0,8) : '-'} branch=${st.parent_branch}`);
  }
  const { data: enr } = await supabase.from('sequence_enrollments').select('*').eq('sequence_id', s.id);
  console.log('ENROLLMENTS:');
  for (const e of enr || []) {
    const cur = steps.find((x) => x.id === e.current_step_id);
    console.log(`  ${e.contact_id.slice(0,8)} status=${e.status} cur_step=${cur ? `num${cur.step_number}` : (e.current_step_id || '').slice(0,8)} next_run_at=${e.next_run_at}`);
  }
  const { data: logs } = await supabase.from('sequence_step_logs').select('*').eq('sequence_id', s.id).order('created_at');
  console.log('STEP LOGS:');
  for (const l of logs || []) {
    const st = steps.find((x) => x.id === l.sequence_step_id);
    console.log(`  ${l.contact_id.slice(0,8)} step=${st ? `num${st.step_number}` : l.sequence_step_id.slice(0,8)} status=${l.status} email_log_id=${l.email_log_id ? l.email_log_id.slice(0,8) : 'null'} opened=${l.opened} sent_at=${l.sent_at}`);
  }
  const { data: emails } = await supabase.from('email_logs').select('id, contact_id, email, status, opened, opened_at, sent_at').in('campaign_id', s.campaign_id ? [s.campaign_id] : []);
  if (emails && emails.length) {
    console.log('EMAIL LOGS (campaign ' + s.campaign_id + '):');
    for (const e of emails) console.log(`  ${e.contact_id.slice(0,8)} status=${e.status} opened=${e.opened} opened_at=${e.opened_at} sent_at=${e.sent_at}`);
  } else {
    console.log('EMAIL LOGS: none (campaign_id=' + s.campaign_id + ')');
  }
}