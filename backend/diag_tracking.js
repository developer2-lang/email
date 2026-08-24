import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await supabase
  .from('email_logs')
  .select('id,campaign_id,contact_id,email,tracking_id,opened,clicked,status,sent_at,created_at');

if (error) {
  console.error('ERROR', error);
  process.exit(1);
}

const byTracking = {};
const byContactCampaign = {};
for (const row of data) {
  byTracking[row.tracking_id] = (byTracking[row.tracking_id] || []).concat(row);
  const key = `${row.campaign_id}|${row.contact_id}`;
  byContactCampaign[key] = (byContactCampaign[key] || []).concat(row);
}

const dupTrack = Object.entries(byTracking).filter(([, v]) => v.length > 1);
const dupContactCampaign = Object.entries(byContactCampaign).filter(([, v]) => v.length > 1);

console.log('DUP_TRACKING', dupTrack.length);
if (dupTrack.length > 0) console.log(JSON.stringify(dupTrack.slice(0, 10), null, 2));
console.log('DUP_CONTACT_CAMPAIGN', dupContactCampaign.length);
if (dupContactCampaign.length > 0) console.log(JSON.stringify(dupContactCampaign.slice(0, 10), null, 2));
console.log('TOTAL_LOGS', data.length);
