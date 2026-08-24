import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

for (const t of ['mail_sequences', 'sequences', 'sequence_steps', 'sequence_branch_steps']) {
  const { data, error } = await supabase.from(t).select('*').limit(1);
  if (error) {
    console.log(`${t}: ERROR ${error.message}`);
  } else {
    const cols = data && data[0] ? Object.keys(data[0]).join(', ') : '(no rows)';
    console.log(`${t}: EXISTS, columns: ${cols}`);
  }
}

const { data: all } = await supabase.from('sequences').select('id, name, status, recipient_type, trigger_type, send_mode');
console.log('\nALL SEQUENCES:');
for (const s of all || []) console.log(`  ${s.id} "${s.name}" status=${s.status} recipient=${s.recipient_type} trigger=${s.trigger_type} send_mode=${s.send_mode}`);

process.exit(0);