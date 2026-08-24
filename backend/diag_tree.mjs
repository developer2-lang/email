import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

for (const seqId of ['6df7f5d6-dac9-44cc-b721-99ff47d615f2', 'e492baf2-a485-4c69-a54f-2a0c95221724', '4bc9ac0d-409e-4f5a-b744-81618108942f']) {
  const { data: steps, error } = await supabase
    .from('sequence_steps')
    .select('id, sequence_id, step_number, parent_step_id, parent_branch, normal_subject, increment_subject, wait_hours')
    .eq('sequence_id', seqId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });
  console.log('\n=== SEQUENCE', seqId, '===');
  if (error) { console.error('ERROR', error.message); continue; }
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const s of steps) {
    const parent = s.parent_step_id ? byId.get(s.parent_step_id) : null;
    console.log(`  id=${s.id} num=${s.step_number} branch=${s.parent_branch} wait=${s.wait_hours} parent=${parent ? `num${parent.step_number}/${parent.parent_branch}` : '-'} normal="${(s.normal_subject||'').slice(0,30)}" inc="${(s.increment_subject||'').slice(0,30)}"`);
  }
}
