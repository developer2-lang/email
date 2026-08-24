import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const sequenceIds = ['96125f69-4d6a-433b-ae6d-302dcbb9a134', 'b7e1d426-79c5-4d4a-97ab-870f0d643db5'];

const { data: sequences } = await supabase
  .from('sequences')
  .select('id, status, send_mode')
  .in('id', sequenceIds);
console.log('sequences:', JSON.stringify(sequences));

const activeAuto = (sequences || []).filter((s) => s.status === 'active' && s.send_mode !== 'manual');
const activeIds = activeAuto.map((s) => s.id);
console.log('active-auto seq ids:', JSON.stringify(activeIds));

const { data: steps } = await supabase
  .from('sequence_steps')
  .select('id, sequence_id, parent_step_id, created_at')
  .in('sequence_id', activeIds)
  .is('archived_at', null);
console.log('\nsteps:');
for (const s of steps || []) {
  console.log(`  id=${s.id} parent=${s.parent_step_id} created=${s.created_at}`);
}

const childAddedByStep = new Map();
for (const step of steps || []) {
  if (!step.parent_step_id) continue;
  const existing = childAddedByStep.get(step.parent_step_id);
  if (!existing || step.created_at < existing) {
    childAddedByStep.set(step.parent_step_id, step.created_at);
  }
}
console.log('\nchildAddedByStep:', JSON.stringify(Object.fromEntries(childAddedByStep)));

const { data: enrollments } = await supabase
  .from('sequence_enrollments')
  .select('id, contact_id, sequence_id, current_step_id, updated_at')
  .in('sequence_id', activeIds)
  .eq('status', 'completed')
  .not('current_step_id', 'is', null);
console.log('\ncompleted enrollments to evaluate:');
const toRevive = [];
for (const enrollment of enrollments || []) {
  const childCreated = childAddedByStep.get(enrollment.current_step_id);
  const completedAt = enrollment.updated_at ? new Date(enrollment.updated_at).getTime() : 0;
  const childMs = childCreated ? new Date(childCreated).getTime() : 0;
  const revive = childCreated && completedAt < childMs;
  console.log(
    `  ${revive ? 'REVIVE ' : 'skip   '} enr=${enrollment.id} seq=${enrollment.sequence_id} cur_step=${enrollment.current_step_id} updated=${enrollment.updated_at} childCreated=${childCreated || '-'}`
  );
  if (revive) toRevive.push(enrollment.id);
}
console.log('\nwould revive', toRevive.length, 'enrollment(s) — NOT applied (dry run)');
