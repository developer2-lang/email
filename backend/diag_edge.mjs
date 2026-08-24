import 'dotenv/config';
import { supabase } from './services/supabaseService.js';

const seqCampaign = '5c60472c-5e20-4199-bb1c-3d75eae93507';

const { data: logs } = await supabase
  .from('email_logs')
  .select('id, campaign_id, contact_id, email, tracking_id, opened, opened_at, sent_at')
  .eq('campaign_id', seqCampaign);
console.log('sequence email_logs:');
for (const l of logs || []) {
  console.log(' ', l.id, 'tracking_id=', l.tracking_id, 'opened=', l.opened, 'sent_at=', l.sent_at);
}

const target = (logs || [])[0];
if (!target) process.exit(0);

const edgeBase = (process.env.SUPABASE_EDGE_FUNCTION_URL || `${process.env.SUPABASE_URL}/functions/v1`).replace(/\/+$/, '');
const url =
  `${edgeBase}/campaign-tracker?action=track` +
  `&campaign_id=${target.campaign_id}` +
  `&contact_email=${encodeURIComponent(target.email)}` +
  `&tracking_id=${target.tracking_id}`;
console.log('\nInvoking edge pixel URL:', url);

const res = await fetch(url);
console.log('HTTP', res.status, 'content-type:', res.headers.get('content-type'));
const buf = Buffer.from(await res.arrayBuffer());
console.log('body bytes:', buf.length, 'prefix:', buf.subarray(0, 8).toString('hex'));

const { data: after } = await supabase
  .from('email_logs')
  .select('id, opened, opened_at')
  .eq('id', target.id)
  .maybeSingle();
console.log('\nafter open: opened=', after && after.opened, 'opened_at=', after && after.opened_at);
