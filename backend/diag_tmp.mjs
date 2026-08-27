import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const seqId = 'e492baf2-a485-4c69-a54f-2a0c95221724';
const contactIds = ['971a8162-6c55-4921-a2fd-39a01e168982','bb91cf05-bcfc-4c0d-be60-a4aebb48a09c','0d74d7c2-4c50-4113-9f6f-deb537aa706d','000f8354-43fa-4b03-aa07-9cd791f0f3f5','e58ecd7d-259d-4fbd-b104-4552b012d973','1ab29b16-ca23-4192-8aae-3d823c9528a6'];

// step logs for this sequence
const { data: stepLogs } = await supabase
  .from('sequence_step_logs')
  .select('id, sequence_step_id, contact_id, email_log_id, sent_at')
  .eq('sequence_id', seqId)
  .order('sent_at', { ascending: true });
console.log('=== step_logs ===');
for (const l of stepLogs) console.log(JSON.stringify(l));

// all email_logs for these contacts
const { data: emailLogs } = await supabase
  .from('email_logs')
  .select('id, campaign_id, contact_id, email, status, opened, opened_at, tracking_id, sent_at, created_at')
  .in('contact_id', contactIds)
  .order('created_at', { ascending: false });
console.log('\n=== email_logs for the 6 contacts ===');
for (const l of emailLogs) console.log(JSON.stringify(l));

// campaign names for the campaigns involved
const campIds = [...new Set(emailLogs.map(l => l.campaign_id))];
const { data: campaigns } = await supabase.from('campaigns').select('id, campaign_name, status').in('id', campIds);
console.log('\n=== campaigns ===');
for (const c of campaigns) console.log(JSON.stringify(c));

// the sequence row
const { data: seq } = await supabase.from('sequences').select('*').eq('id', seqId).maybeSingle();
console.log('\n=== sequence row ===');
console.log(JSON.stringify(seq, null, 2));
