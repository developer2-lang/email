import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const { data: seqs } = await supabase
  .from('sequences')
  .select('id, name, status, send_mode')
  .eq('status', 'active')
  .order('created_at', { ascending: false });

for (const seq of seqs || []) {
  console.log(`\n════ SEQ ${seq.name} (${seq.id}) mode=${seq.send_mode} ════`);

  const { data: steps, error: e2 } = await supabase
    .from('sequence_steps')
    .select('id, step_number, parent_step_id, parent_branch, wait_hours, send_after_value, send_after_unit')
    .eq('sequence_id', seq.id)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (e2) console.log('steps ERROR:', e2.message);
  const stepById = new Map((steps || []).map((s) => [s.id, s]));
  console.log('steps:');
  for (const s of steps || []) {
    console.log(`  id=${s.id} num=${s.step_number} parent=${s.parent_step_id} branch=${s.parent_branch} wait=${s.wait_hours} after=${s.send_after_value}${s.send_after_unit || ''}`);
  }

  const { data: enr, error: e1 } = await supabase
    .from('sequence_enrollments')
    .select('id, contact_id, current_step, current_step_id, status, next_run_at, updated_at')
    .eq('sequence_id', seq.id)
    .eq('status', 'active');
  if (e1) console.log('enrollments ERROR:', e1.message);
  console.log(`active enrollments: ${(enr || []).length}`);
  for (const row of enr || []) {
    const step = row.current_step_id ? stepById.get(row.current_step_id) : null;
    const label = step
      ? `step ${step.step_number}${step.parent_branch === 'NOT_OPENED' ? 'A' : ''} branch=${step.parent_branch} wait=${step.wait_hours}`
      : `raw cur_step=${row.current_step} step_id=${row.current_step_id || 'null'}`;
    console.log(`  enr=${row.id} contact=${row.contact_id} ${label} next_run=${row.next_run_at} updated=${row.updated_at}`);
  }

  const { data: stepLogs, error: e3 } = await supabase
    .from('sequence_step_logs')
    .select('sequence_step_id, contact_id, email_log_id, status, sent_at')
    .eq('sequence_id', seq.id);
  if (e3) console.log('step_logs ERROR:', e3.message);
  console.log('step_logs:');
  for (const l of stepLogs || []) {
    const s = l.sequence_step_id ? stepById.get(l.sequence_step_id) : null;
    const label = s ? `step ${s.step_number}${s.parent_branch === 'NOT_OPENED' ? 'A' : ''}` : l.sequence_step_id;
    console.log(`  ${label} contact=${l.contact_id} email_log_id=${l.email_log_id} status=${l.status} sent_at=${l.sent_at}`);
  }
}