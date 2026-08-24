import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const SEQ = '6df7f5d6-dac9-44cc-b721-99ff47d615f2';

const { data: steps } = await supabase
  .from('sequence_steps')
  .select('id, step_number, parent_step_id, parent_branch, wait_hours')
  .eq('sequence_id', SEQ)
  .is('archived_at', null)
  .order('step_number', { ascending: true });
console.log('STEPS:');
for (const s of steps || []) {
  console.log(`  id=${s.id} num=${s.step_number} parent=${s.parent_step_id} branch=${s.parent_branch} wait=${s.wait_hours}`);
}
const stepById = Object.fromEntries((steps || []).map((s) => [s.id, s]));

const { data: enr } = await supabase
  .from('sequence_enrollments')
  .select('*')
  .eq('sequence_id', SEQ);
console.log('\nENROLLMENTS:');
for (const e of enr || []) {
  console.log(`  contact=${e.contact_id} cur_step=${e.current_step_id} (${e.current_step}) status=${e.status} next_run=${e.next_run_at} updated=${e.updated_at} enrolled=${e.enrolled_at}`);
}

const { data: logs } = await supabase
  .from('email_logs')
  .select('id, contact_id, email, status, opened, opened_at, sent_at, created_at')
  .eq('campaign_id', '16fa10e5-9af5-4c10-8c9a-3431aecba0af')
  .order('sent_at', { ascending: true });
console.log('\nEMAIL_LOGS:');
for (const l of logs || []) {
  console.log(`  ${l.id} contact=${l.contact_id} status=${l.status} opened=${l.opened} opened_at=${l.opened_at} sent_at=${l.sent_at} created=${l.created_at}`);
}

const { data: stepLogs } = await supabase
  .from('sequence_step_logs')
  .select('*, sequence_steps(step_number, parent_branch)')
  .eq('sequence_id', SEQ)
  .order('sent_at', { ascending: true });
console.log('\nSTEP_LOGS (with resolved step):');
for (const l of stepLogs || []) {
  const st = l.sequence_steps;
  console.log(`  step=${l.sequence_step_id}(num=${st && st.step_number} branch=${st && st.parent_branch}) contact=${l.contact_id} email_log_id=${l.email_log_id} opened=${l.opened} sent_at=${l.sent_at}`);
}

const { data: contacts } = await supabase
  .from('contacts')
  .select('id, email')
  .in('id', (logs || []).map((l) => l.contact_id));
const emailByContact = Object.fromEntries((contacts || []).map((c) => [c.id, c.email]));
console.log('\nCONTACTS:');
for (const [cid, email] of Object.entries(emailByContact)) {
  console.log(`  ${cid} ${email}`);
}