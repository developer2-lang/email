import 'dotenv/config';
import { supabase } from './services/supabaseService.js';
import * as sequenceService from './services/sequenceService.js';

const { data: seqs, error: e1 } = await supabase
  .from('sequences')
  .select('id, name, status, campaign_id, send_mode')
  .order('created_at', { ascending: false });
if (e1) {
  console.error('ERROR listing sequences:', e1.message);
  process.exit(1);
}

for (const seq of seqs.slice(0, 10)) {
  console.log('\n════════════════════════════════════════════════');
  console.log(`SEQUENCE: ${seq.name} (${seq.id}) status=${seq.status} campaign=${seq.campaign_id}`);
  if (!seq.campaign_id) {
    console.log('  no dedicated campaign');
    continue;
  }

  const { data: logs, error: e2 } = await supabase
    .from('email_logs')
    .select('id, contact_id, email, status, opened, opened_at, tracking_id')
    .eq('campaign_id', seq.campaign_id)
    .order('created_at', { ascending: true });
  if (e2) console.log('  email_logs ERROR:', e2.message);
  else {
    console.log(`  email_logs total=${logs.length} opened=${logs.filter((l) => l.opened === true).length} sent=${logs.filter((l) => l.status === 'sent').length}`);
    for (const l of logs) {
      console.log(`    email_log ${l.id} contact=${l.contact_id} status=${l.status} opened=${l.opened} opened_at=${l.opened_at}`);
    }
  }

  const { data: stepLogs, error: e3 } = await supabase
    .from('sequence_step_logs')
    .select('id, sequence_step_id, contact_id, email_log_id, opened, sent_at, status')
    .eq('sequence_id', seq.id)
    .order('sent_at', { ascending: true });
  if (e3) console.log('  step_logs ERROR:', e3.message);
  else {
    console.log(`  step_logs total=${stepLogs.length}`);
    for (const l of stepLogs) {
      console.log(`    step_log step=${l.sequence_step_id} contact=${l.contact_id} email_log_id=${l.email_log_id} opened=${l.opened}`);
    }
  }

  try {
    const detail = await sequenceService.getSequence(seq.id);
    console.log('  engagement:', JSON.stringify(detail.engagement));
    console.log('  summary:', JSON.stringify(detail.summary));
    for (const p of detail.steps_progress || []) {
      console.log(
        `  progress step=${p.step.step_number} path=${p.path} eligible=${p.eligible} sent=${p.sent} opened=${p.opened} clicked=${p.clicked} status=${p.status}`
      );
    }
  } catch (error) {
    console.log('  getSequence ERROR:', error.message);
  }
}
