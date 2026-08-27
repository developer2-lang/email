import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const { data: seqs } = await supabase.from('sequences').select('id, name, status, created_at').order('created_at');
for (const s of seqs || []) {
  const { data: steps } = await supabase
    .from('sequence_steps')
    .select('id, step_number, parent_branch, normal_subject, increment_subject, wait_hours')
    .eq('sequence_id', s.id)
    .is('archived_at', null)
    .order('created_at');
  const start = (steps || []).filter((st) => st.parent_branch === 'STARTING').map((st) => st.normal_subject);
  console.log(
    s.id.slice(0, 8), s.name, '(' + s.status + ')', 'created', s.created_at,
    '| STARTING subjects:', JSON.stringify(start)
  );
}
console.log('--- branch rows now ---');
const { data: rows } = await supabase.from('sequence_branch_steps').select('id, step, parent_branch, subject, sequence_id, wait_hours').order('step');
for (const r of rows || []) {
  console.log('row', r.id, 'step=' + r.step, r.parent_branch, 'seq=' + (r.sequence_id || '').slice(0, 8), 'wait=' + r.wait_hours, JSON.stringify(r.subject));
}
process.exit(0);
