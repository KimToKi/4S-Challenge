const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL
  || process.env.SUPABASE_REST_URL
  || process.env.SUPABASE_PROJECT_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase configuration (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

async function ensureTable(table) {
  const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' });
  if (error) {
    if (/relation .* does not exist/i.test(error.message || '')) {
      throw new Error(`Table "${table}" is missing. Apply schema.sql via the Supabase SQL editor or CLI, then re-run this script.`);
    }
    throw error;
  }
}

async function seedScoreRules() {
  const rows = [
    { command: '/bm_product', subtype: '', points: 1 },
    { command: '/pack3', subtype: '', points: 4 },
    { command: '/old_member', subtype: '', points: 1 },
    { command: '/sop', subtype: '', points: 2 },
    { command: '/plan_update', subtype: 'success', points: 4 },
    { command: '/plan_update', subtype: 'fail', points: -10 },
    { command: '/use_product', subtype: '', points: 1 },
    { command: '/link_30d', subtype: 'success', points: 4 },
    { command: '/link_30d', subtype: 'fail', points: -1 },
    { command: '/link_30d', subtype: 'none', points: 0 },
    { command: '/book', subtype: 'success', points: 4 },
    { command: '/book', subtype: 'fail', points: -4 }
  ];
  const { error } = await supabase.from('score_rules').upsert(rows, { onConflict: 'command,subtype' });
  if (error) throw error;
}

(async () => {
  try {
    await ensureTable('events');
    await ensureTable('score_rules');
    await ensureTable('pending');
  } catch (err) {
    console.error(err?.message || err);
    console.error('Run the statements in schema.sql using Supabase SQL before running this initializer.');
    process.exit(1);
  }

  try {
    await seedScoreRules();
    console.log('✅ Supabase tables verified and score rules seeded.');
  } catch (err) {
    console.error('Failed to seed score rules:', err?.message || err);
    process.exit(1);
  }
})();
