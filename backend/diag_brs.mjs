import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

// What columns does sequence_branch_steps actually have? Fetch one row shape.
const { data, error } = await supabase
  .from('sequence_branch_steps')
  .select('*')
  .limit(5);
console.log('sequence_branch_steps first rows:', error ? error.message : data);

const { data: seqRows, error: e2 } = await supabase
  .from('sequence_branch_steps')
  .select('*')
  .eq('sequence_id', '6df7f5d6-dac9-44cc-b721-99ff47d615f2');
console.log('test6 branch steps:', e2 ? e2.message : seqRows);