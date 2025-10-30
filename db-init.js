const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.SUPABASE_DB_URL
  || process.env.SUPABASE_POSTGRES_URL
  || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Missing Supabase/Postgres connection string (SUPABASE_DB_URL or DATABASE_URL)');
  process.exit(1);
}

const SQL = fs.readFileSync('./schema.sql', 'utf8');

async function applySchema() {
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  try {
    await client.query(SQL);
    console.log('✅ Supabase/Postgres schema applied.');
  } catch (err) {
    console.error('DB init error', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

applySchema().catch((err) => {
  console.error('Failed to run schema migration:', err?.message || err);
  process.exit(1);
});
