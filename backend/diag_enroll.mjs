import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const seqs = ['96125f69-4d6a-433b-ae6d-302dcbb9a134', 'b7e1d426-79c5-4d4a-97ab-870f0d643db5'];
for (const seqId of seqs) {
  console.log('\n════ SEQ', seqId, '════');
  const { data: enr, error: e1 } = await supabase
    .from('sequence_enrollments')
    .select('contact_id, current_step, current_step_id, status, next_run_at, updated_at')
    .eq('sequence_id', seqId);
  if (e1) console.log('enrollments ERROR:', e1.message);
  for (const row of enr || []) {
    console.log(`  contact=${row.contact_id} cur_step=${row.current_step} cur_step_id=${row.current_step_id} status=${row.status} next_run=${row.next_run_at} updated=${row.updated_at}`);
  }

  const { data: steps, error: e2 } = await supabase
    .from('sequence_steps')
    .select('id, step_number, parent_step_id, parent_branch, wait_hours')
    .eq('sequence_id', seqId)
    .is('archived_at', null);
  if (e2) console.log('steps ERROR:', e2.message);
  console.log('steps:');
  for (const s of steps || []) {
    console.log(`  id=${s.id} num=${s.step_number} parent=${s.parent_step_id} branch=${s.parent_branch} wait=${s.wait_hours}`);
  }

  const { data: logs, error: e3 } = await supabase
    .from('sequence_step_logs')
    .select('sequence_step_id, contact_id, email_log_id, sent_at')
    .eq('sequence_id', seqId);
  if (e3) console.log('step_logs ERROR:', e3.message);
  console.log('step_logs:');
  for (const l of logs || []) {
    console.log(`  step=${l.sequence_step_id} contact=${l.contact_id} email_log_id=${l.email_log_id} sent_at=${l.sent_at}`);
  }
}
