import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

async function columns(table) {
  const { data, error } = await supabase
    .from('information_schema.columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_schema', 'public')
    .eq('table_name', table)
    .order('ordinal_position');
  if (error) return { error: error.message };
  return { columns: data };
}

async function tables() {
  const { data, error } = await supabase
    .from('information_schema.tables')
    .select('table_name')
    .eq('table_schema', 'public')
    .in('table_name', ['sequences', 'mail_sequences', 'sequence_steps', 'sequence_branch_steps', 'sequence_enrollments', 'sequence_step_logs', 'email_logs', 'campaigns']);
  if (error) return { error: error.message };
  return { tables: data };
}

const t = await tables();
console.log('TABLES:', JSON.stringify(t));

for (const tbl of ['sequences', 'mail_sequences', 'sequence_steps', 'sequence_branch_steps']) {
  const c = await columns(tbl);
  console.log(`\n== columns ${tbl} ==`);
  if (c.error) { console.log('  ERROR', c.error); continue; }
  for (const col of c.columns) {
    console.log(`  ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}${col.column_default ? ' default=' + col.column_default : ''}`);
  }
}

// sample rows
for (const tbl of ['sequences', 'sequence_steps', 'sequence_branch_steps']) {
  const { data, error } = await supabase.from(tbl).select('*').limit(3);
  console.log(`\n== sample ${tbl} ==`);
  if (error) console.log('  ERROR', error.message);
  else console.log('  ', JSON.stringify(data, null, 2).slice(0, 3000));
}

process.exit(0);