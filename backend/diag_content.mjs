import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const seqId = 'b1477445-b287-4e3b-91bd-84b387981a5d';
const { data: steps } = await supabase
  .from('sequence_steps')
  .select('id, step_number, parent_step_id, parent_branch, normal_subject, normal_body, increment_subject, increment_body, wait_hours, recipient_type, from_name')
  .eq('sequence_id', seqId)
  .is('archived_at', null);
const byId = new Map(steps.map(s => [s.id, s]));
for (const s of steps) {
  console.log('+--------------');
  console.log(`id=${s.id}`);
  console.log(`num=${s.step_number} branch=${s.parent_branch} parent=${s.parent_step_id ? byId.get(s.parent_step_id)?.step_number + '/id=' + s.parent_step_id : '-'} wait=${s.wait_hours} recip=${s.recipient_type} from=${s.from_name}`);
  console.log(`normal_subj=${JSON.stringify(s.normal_subject)}`);
  console.log(`normal_body=${JSON.stringify(s.normal_body)}`);
  console.log(`increment_subj=${JSON.stringify(s.increment_subject)}`);
  console.log(`increment_body=${JSON.stringify(s.increment_body)}`);
}
