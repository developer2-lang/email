import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

// Build per-sequence key sets: (step|branch|subject|body) using the same
// mirror mapping the app uses (STARTING/OPENED -> normal, NOT_OPENED -> increment).
const { data: seqs } = await supabase.from('sequences').select('id, name');
const keysBySeq = new Map();
for (const s of seqs || []) {
  const { data: steps } = await supabase
    .from('sequence_steps')
    .select('step_number, parent_branch, normal_subject, normal_body, increment_subject, increment_body, wait_hours')
    .eq('sequence_id', s.id)
    .is('archived_at', null);
  const set = new Set();
  for (const st of steps || []) {
    const notOpened = st.parent_branch === 'NOT_OPENED';
    const subject = notOpened ? (st.increment_subject || '') : (st.normal_subject || '');
    const body = notOpened ? (st.increment_body || '') : (st.normal_body || '');
    set.add(`${Number(st.step_number)}|${st.parent_branch}|${subject}|${body}`);
  }
  keysBySeq.set(s.id, set);
}

const { data: rows } = await supabase
  .from('sequence_branch_steps')
  .select('id, step, parent_step, parent_branch, subject, body, sequence_id, wait_hours');

let matched = 0, unmatched = 0, updated = 0;
for (const r of rows || []) {
  if (r.sequence_id) continue;
  const key = `${Number(r.step)}|${r.parent_branch}|${r.subject}|${r.body}`;
  let target = null;
  for (const [sid, set] of keysBySeq) {
    if (set.has(key)) { target = sid; break; }
  }
  if (!target) { unmatched++; console.log('UNMATCHED row', r.id, key); continue; }
  matched++;
  // wait_hours from the matching node (mirror semantics: the branch node's wait).
  const { data: node } = await supabase
    .from('sequence_steps')
    .select('wait_hours')
    .eq('sequence_id', target)
    .eq('step_number', Number(r.step))
    .eq('parent_branch', r.parent_branch)
    .is('archived_at', null)
    .maybeSingle();
  const wait = node && node.wait_hours != null ? Number(node.wait_hours) : 0;
  const { error } = await supabase
    .from('sequence_branch_steps')
    .update({ sequence_id: target, wait_hours: wait, updated_at: new Date().toISOString() })
    .eq('id', r.id);
  if (error) { console.log('UPDATE FAILED row', r.id, error.message); continue; }
  updated++;
  console.log('row', r.id, `step=${r.step} ${r.parent_branch}`, '->', target.slice(0, 8), 'wait=' + wait);
}
console.log(`\nmatched=${matched} updated=${updated} unmatched=${unmatched}`);
process.exit(0);
