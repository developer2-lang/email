import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const { data: cols, error: colErr } = await supabase.from('sequence_branch_steps').select('*').limit(1);
console.log('columns sample:', JSON.stringify(cols, null, 2));
console.log('colErr:', colErr && colErr.message);

const { data: rows, error } = await supabase
  .from('sequence_branch_steps')
  .select('id, sequence_id, step, parent_step, parent_branch, subject, wait_hours')
  .eq('sequence_id', 'b1477445-b287-4e3b-91bd-84b387981a5d')
  .order('step', { ascending: true });
console.log('\n--- sequence5 branch steps ---');
if (error) console.error('ERROR', error.message);
for (const r of rows || []) console.log(`id=${r.id} step=${r.step} parent_step=${r.parent_step} branch=${r.parent_branch} wait=${r.wait_hours} subj="${(r.subject||'').slice(0,40)}"`);
