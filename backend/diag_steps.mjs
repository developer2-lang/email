import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const { data: steps, error } = await supabase
  .from('sequence_steps')
  .select('id, sequence_id, step_number, parent_step_id, parent_branch, wait_hours, created_at, updated_at')
  .eq('sequence_id', '96125f69-4d6a-433b-ae6d-302dcbb9a134')
  .is('archived_at', null)
  .order('created_at', { ascending: true });
if (error) console.log('ERROR', error.message);
for (const s of steps || []) {
  console.log(`step id=${s.id} num=${s.step_number} branch=${s.parent_branch} wait=${s.wait_hours} created=${s.created_at} updated=${s.updated_at}`);
}
