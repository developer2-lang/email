import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const { data: openedLogs, error: e1 } = await supabase
  .from('email_logs')
  .select('id, campaign_id, contact_id, email, status, opened, opened_at, tracking_id, sent_at')
  .eq('opened', true)
  .limit(50);
console.log('email_logs with opened=true:', e1 ? e1.message : openedLogs.length);
for (const l of openedLogs || []) {
  console.log('  ', l.id, 'campaign=', l.campaign_id, 'contact=', l.contact_id, l.email, 'opened_at=', l.opened_at);
}

const { data: contacts, error: e2 } = await supabase
  .from('contacts')
  .select('id, email, email_opened, contact_type')
  .eq('email_opened', true)
  .limit(50);
console.log('contacts with email_opened=true:', e2 ? e2.message : contacts.length);
for (const c of contacts || []) {
  console.log('  ', c.id, c.email, 'type=', c.contact_type);
}

const { data: stepOpened, error: e3 } = await supabase
  .from('sequence_step_logs')
  .select('sequence_id, sequence_step_id, contact_id, email_log_id, opened')
  .eq('opened', true)
  .limit(50);
console.log('step_logs with opened=true:', e3 ? e3.message : stepOpened.length);

const { data: seqLogs, error: e4 } = await supabase
  .from('sequence_step_logs')
  .select('email_log_id')
  .not('email_log_id', 'is', null)
  .limit(100000);
console.log('step_logs with non-null email_log_id:', e4 ? e4.message : seqLogs.length);

const { data: nullLink, error: e5 } = await supabase
  .from('sequence_step_logs')
  .select('id, sequence_id, sequence_step_id, contact_id')
  .is('email_log_id', null)
  .limit(50);
console.log('step_logs with NULL email_log_id:', e5 ? e5.message : nullLink.length);
for (const r of nullLink || []) {
  console.log('  ', r.id, 'seq=', r.sequence_id, 'step=', r.sequence_step_id, 'contact=', r.contact_id);
}
