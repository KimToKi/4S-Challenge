try { require('dotenv').config(); } catch (_) {}

const store = require('./data-store');

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
  await store.upsertScoreRules(rows);
}

(async () => {
  try {
    await store.ensureFile();
    await seedScoreRules();
    console.log('✅ Offline data store ready and score rules seeded.');
  } catch (err) {
    console.error('Failed to prepare local data store:', err?.message || err);
    process.exit(1);
  }
})();
