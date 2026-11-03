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

function resolveDatabaseUrl() {
  return process.env.SUPABASE_DB_URL
    || process.env.SUPABASE_POSTGRES_URL
    || process.env.SUPABASE_DB_CONNECTION_STRING
    || process.env.DATABASE_URL
    || null;
}

function shouldUseSsl(url) {
  if (!url) return false;
  if (/sslmode=disable/i.test(url)) return false;
  if (/localhost|127\.0\.0\.1/i.test(url)) return false;
  return true;
}

function isMissingTableError(error, table) {
  const message = `${error?.message || error?.details || error?.hint || ''}`.toLowerCase();
  if (!message) return false;
  return message.includes('does not exist') && message.includes(table.toLowerCase());
}

async function createTable(connectionString, sql) {
  let pool;
  try {
    const { Pool } = require('pg');
    const poolConfig = { connectionString };
    if (shouldUseSsl(connectionString)) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(poolConfig);
    await pool.query(sql);
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}

async function ensureTable(table, createSql) {
  const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' });
  if (!error) return;

  if (!isMissingTableError(error, table)) {
    throw error;
  }

  if (!createSql) {
    throw new Error(`Table "${table}" is missing. Apply schema.sql via the Supabase SQL editor or CLI, then re-run this script.`);
  }

  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error(`Table "${table}" is missing. Provide SUPABASE_DB_URL (or DATABASE_URL) so it can be created automatically, or apply schema.sql manually.`);
  }

  try {
    await createTable(connectionString, createSql);
  } catch (err) {
    throw new Error(`Failed to create table "${table}": ${err?.message || err}`);
  }

  const verify = await supabase.from(table).select('*', { head: true, count: 'exact' });
  if (verify.error) {
    throw new Error(`Created table "${table}" but Supabase still cannot access it: ${verify.error.message || verify.error}`);
  }
}

async function ensurePendingMetadataColumn() {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) return;
  let pool;
  try {
    const { Pool } = require('pg');
    const poolConfig = { connectionString };
    if (shouldUseSsl(connectionString)) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(poolConfig);
    await pool.query('ALTER TABLE IF EXISTS public.pending ADD COLUMN IF NOT EXISTS metadata TEXT;');
  } catch (err) {
    console.warn('Failed to ensure pending.metadata column:', err?.message || err);
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}

async function ensureEventsPointsNumeric() {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) return;
  let pool;
  try {
    const { Pool } = require('pg');
    const poolConfig = { connectionString };
    if (shouldUseSsl(connectionString)) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(poolConfig);
    await pool.query('ALTER TABLE IF EXISTS public.events ALTER COLUMN points TYPE NUMERIC(10,2) USING points::NUMERIC;');
  } catch (err) {
    console.warn('Failed to ensure events.points numeric type:', err?.message || err);
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}

(async () => {
  try {
    await ensureTable('events');
    await ensureTable('pending', `
      CREATE TABLE IF NOT EXISTS public.pending (
        user_id TEXT NOT NULL,
        command TEXT NOT NULL,
        date_key DATE NOT NULL,
        month_key TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, command, date_key)
      );
    `);
    await ensureTable('daily_announcements', `
      CREATE TABLE IF NOT EXISTS public.daily_announcements (
        chat_id TEXT NOT NULL,
        date_key DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (chat_id, date_key)
      );
    `);
    await ensurePendingMetadataColumn();
    await ensureEventsPointsNumeric();
  } catch (err) {
    console.error(err?.message || err);
    console.error('Run the statements in schema.sql using Supabase SQL before running this initializer.');
    process.exit(1);
  }

  console.log('✅ Supabase tables verified.');
})();
