import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const { data: seqs } = await supabase.from('sequences').select('*').order('created_at', { ascending: false });
console.log(`SEQUENCES: ${(seqs || []).length}\n`);

for (const s of seqs || []) {
  const { data: steps } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', s.id)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  const { data: flat } = await supabase
    .from('sequence_branch_steps')
    .select('*')
    .eq('sequence_id', s.id)
    .order('step', { ascending: true });

  console.log(`--- ${s.id} "${s.name}" status=${s.status} send_mode=${s.send_mode} recipient_type=${s.recipient_type} trigger=${s.trigger_type} audience="${s.audience_segment}"`);
  console.log(`    sequences.subject_1="${s.subject_1}" body_1="${s.body_1}" subject_2="${s.subject_2}" body_2="${s.body_2}" subject_2a="${s.subject_2a}"`);

  for (const st of steps || []) {
    console.log(`    STEP(id=${st.id.slice(0,8)}) n=${st.step_number} branch=${st.parent_branch} parent=${st.parent_step_id ? st.parent_step_id.slice(0,8) : '-'} wait=${st.wait_hours} ns="${st.normal_subject}" ib="${st.increment_subject}" ni="${st.normal_body}" inc="${st.increment_body}" from="${st.from_name}"`);
  }
  for (const f of flat || []) {
    console.log(`    FLAT(id=${f.id}) n=${f.step} branch=${f.parent_branch} parent_step=${f.parent_step} parent_step_id=${f.parent_step_id} wait=${f.wait_hours} subj="${f.subject}" body="${f.body}"`);
  }
  if ((steps || []).length === 0 && (flat || []).length === 0) console.log('    (no steps, no flat rows)');
  console.log('');
}

process.exit(0);