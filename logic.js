const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const manualSettleSecret = process.env.MANUAL_SETTLE_SECRET || 'NewSilver21%';

const supabaseUrl = process.env.SUPABASE_URL
  || process.env.SUPABASE_REST_URL
  || process.env.SUPABASE_PROJECT_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_KEY
  || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase configuration (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

const configuredTz = process.env.SCORE_TIMEZONE
  || process.env.TIMEZONE
  || process.env.APP_TIMEZONE
  || 'Asia/Bangkok';
let activeTimeZone = configuredTz;
let cachedFormatter;
let cachedWeekdayFormatter;

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  let url = String(raw).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

function publicBaseUrl() {
  return normalizeBaseUrl(process.env.PUBLIC_BASE_URL)
    || normalizeBaseUrl(process.env.PUBLIC_URL)
    || normalizeBaseUrl(process.env.BASE_URL)
    || normalizeBaseUrl(process.env.APP_BASE_URL)
    || normalizeBaseUrl(process.env.APP_URL)
    || normalizeBaseUrl(process.env.SITE_URL)
    || normalizeBaseUrl(process.env.URL)
    || normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL)
    || normalizeBaseUrl(process.env.VERCEL_URL)
    || normalizeBaseUrl(`http://localhost:${process.env.PORT || 3000}`);
}

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

async function ensurePendingTable() {
  const check = await supabase
    .from('pending')
    .select('user_id', { head: true, count: 'exact' })
    .limit(1);

  if (!check.error) {
    return;
  }

  const msg = `${check.error?.message || check.error?.details || ''}`.toLowerCase();
  if (!msg.includes('pending') || (!msg.includes('does not exist') && !msg.includes('schema cache'))) {
    throw new Error(`Failed to access pending table: ${check.error?.message || check.error}`);
  }

  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error('Supabase table "pending" is missing. Provide SUPABASE_DB_URL (or DATABASE_URL) or create it from schema.sql');
  }

  let pool;
  try {
    const { Pool } = require('pg');
    const poolConfig = { connectionString };
    if (shouldUseSsl(connectionString)) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(poolConfig);
    await pool.query(`
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
    await pool.query('ALTER TABLE public.pending ADD COLUMN IF NOT EXISTS metadata TEXT;');
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }

  const verify = await supabase
    .from('pending')
    .select('user_id', { head: true, count: 'exact' })
    .limit(1);
  if (verify.error) {
    throw new Error(`Pending table created but still not accessible: ${verify.error?.message || verify.error}`);
  }
}

async function ensureEventsPointsNumericType() {
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
    await pool.query('ALTER TABLE IF EXISTS public.events ALTER COLUMN points TYPE NUMERIC(12,2) USING points::NUMERIC;');
  } catch (err) {
    console.warn('Failed to ensure events.points numeric type:', err?.message || err);
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }
}

const dbReady = (async () => {
  await ensureEventsPointsNumericType();
  await ensurePendingTable();
})().catch((err) => {
  console.error('Database initialization error:', err?.message || err);
});

function getZonedDateParts(date = new Date()) {
  if (!cachedFormatter) {
    try {
      cachedFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: activeTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch (err) {
      console.warn(`Invalid timezone '${configuredTz}', fallback to UTC`);
      activeTimeZone = 'UTC';
      cachedFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: activeTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }
  }
  const parts = cachedFormatter.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type === 'year') map.year = p.value;
    if (p.type === 'month') map.month = p.value;
    if (p.type === 'day') map.day = p.value;
  }
  return map;
}

function localDateKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `${parts.year}-${parts.month}`;
}

function isoWeekKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  const y = Number(parts.year);
  const m = Number(parts.month) - 1;
  const d = Number(parts.day);
  const local = new Date(Date.UTC(y, m, d));
  const weekday = (local.getUTCDay() + 6) % 7; // Monday=0
  local.setUTCDate(local.getUTCDate() - weekday + 3); // move to Thursday
  const weekYear = local.getUTCFullYear();
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(weekYear, 0, 4 - jan4Weekday));
  const weekNumber = 1 + Math.floor((local - week1Monday) / 604800000);
  return `${weekYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function getZonedWeekdayIndex(date = new Date()) {
  if (!cachedWeekdayFormatter) {
    cachedWeekdayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: activeTimeZone,
      weekday: 'short'
    });
  }
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const value = cachedWeekdayFormatter.format(date);
  return map[value] ?? 0;
}

function isWeekend(date = new Date()) {
  const idx = getZonedWeekdayIndex(date);
  return idx === 0 || idx === 6;
}

function roundTo(value, precision = 2) {
  const factor = Math.pow(10, precision);
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatNumber(value, maxFractionDigits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const rounded = roundTo(num, maxFractionDigits);
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(maxFractionDigits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatPoints(value) {
  return formatNumber(value, 2);
}

function pick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

async function replyMessages(replyToken, messages) {
  if (!replyToken || !Array.isArray(messages) || !messages.length) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages
    }, {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('reply error', err?.response?.data || err?.message || err);
  }
}

async function reply(replyToken, text) {
  if (!text) return;
  await replyMessages(replyToken, [{ type: 'text', text }]);
}

async function replyImage(replyToken, url) {
  if (!url) return;
  await replyMessages(replyToken, [{
    type: 'image',
    originalContentUrl: url,
    previewImageUrl: url
  }]);
}

function composeInspireText(text, displayName) {
  const quote = pick(messagePools.inspire) || '';
  if (!quote) return text;
  const name = displayName ? `✨ ${displayName}` : '✨';
  return `${text}\n${name} ${quote}`;
}

async function replyWithInspire(replyToken, text, displayName) {
  await reply(replyToken, composeInspireText(text, displayName));
}

async function replyWithInspireAndTotal(replyToken, baseMessage, displayName, userId, mk, points) {
  let message = baseMessage;
  if (Number.isFinite(points) && points !== 0) {
    const total = await sumUserMonth(userId, mk);
    message = `${baseMessage}\n💎 คะแนนสะสมรวม: ${formatPoints(total)} คะแนน`;
  }
  await replyWithInspire(replyToken, message, displayName);
}

async function push(text) {
  const to = process.env.LINE_TARGET_ID || process.env.LINE_GROUP_ID || process.env.LINE_USER_ID;
  if (!to) {
    console.warn('No LINE_TARGET_ID/LINE_GROUP_ID/LINE_USER_ID set; skip push');
    return;
  }
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('push error', err?.response?.data || err?.message || err);
  }
}

function aggregateEventsByUser(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const id = row.user_id;
    if (!id) continue;
    const current = map.get(id) || { user_id: id, display_name: '', points: 0 };
    const name = row.display_name || '';
    if (name && name > current.display_name) {
      current.display_name = name;
    }
    current.points += Number(row.points || 0);
    map.set(id, current);
  }
  return Array.from(map.values());
}

async function insertEvent(event) {
  await dbReady;
  const payload = {
    user_id: event.user_id,
    display_name: event.display_name,
    command: event.command,
    detail: event.detail ?? null,
    points: roundTo(event.points, 2),
    month_key: event.month_key ?? monthKey()
  };
  const attempt = async () => {
    const { data, error } = await supabase
      .from('events')
      .insert(payload)
      .select('id')
      .single();
    if (error) throw error;
    return data?.id || null;
  };
  try {
    return await attempt();
  } catch (err) {
    const msg = `${err?.message || err?.error_description || err?.details || ''}`.toLowerCase();
    const looksNumeric = msg.includes('integer') || msg.includes('numeric');
    if (!looksNumeric) throw err;
    try {
      await ensureEventsPointsNumericType();
    } catch (_) {}
    return await attempt();
  }
}

async function sumUserMonth(userId, mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('points')
    .eq('user_id', userId)
    .eq('month_key', mk);
  if (error) throw new Error(error.message || 'Failed to sum points');
  const total = (data || []).reduce((sum, row) => sum + Number(row.points || 0), 0);
  return roundTo(total, 2);
}

async function loadRulePoints(command, subtype = '') {
  await dbReady;
  const { data, error } = await supabase
    .from('score_rules')
    .select('points')
    .ilike('command', command)
    .ilike('subtype', subtype || '')
    .limit(1)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Failed to load score rule');
  }
  return data ? Number(data.points) : null;
}

async function countUserCommandThisMonth(userId, command, mk) {
  await dbReady;
  const query = supabase
    .from('events')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', command);
  const { count, error } = await query;
  if (error) throw new Error(error.message || 'Failed to count events');
  return count || 0;
}

async function hasLink30dToday(userId) {
  await dbReady;
  const mk = monthKey();
  const today = localDateKey();
  const { data, error } = await supabase
    .from('events')
    .select('timestamp')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', '/link_30d')
    .order('timestamp', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message || 'Failed to check /link_30d');
  return (data || []).some((row) => localDateKey(new Date(row.timestamp)) === today);
}

async function hasUseProductToday(userId) {
  await dbReady;
  const mk = monthKey();
  const today = localDateKey();
  const { data, error } = await supabase
    .from('events')
    .select('timestamp')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', '/use_product')
    .order('timestamp', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message || 'Failed to check /use_product');
  return (data || []).some((row) => localDateKey(new Date(row.timestamp)) === today);
}

async function listPlanUpdateEvents(userId, mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('id, timestamp, points, detail')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', '/plan_update')
    .order('timestamp', { ascending: true });
  if (error) throw new Error(error.message || 'Failed to load /plan_update events');
  return data || [];
}

async function upsertPending(userId, command, metadata = null) {
  await dbReady;
  const entry = {
    user_id: userId,
    command,
    date_key: localDateKey(),
    month_key: monthKey(),
    metadata: metadata ? JSON.stringify(metadata) : null,
    created_at: new Date().toISOString()
  };
  const { error } = await supabase
    .from('pending')
    .upsert(entry, { onConflict: 'user_id,command,date_key' });
  if (error) throw new Error(error.message || 'Failed to upsert pending');
  return entry;
}

async function consumePending(userId, command) {
  await dbReady;
  const { data, error } = await supabase
    .from('pending')
    .delete()
    .eq('user_id', userId)
    .eq('command', command)
    .eq('date_key', localDateKey())
    .select()
    .limit(1);
  if (error) throw new Error(error.message || 'Failed to consume pending');
  if (!data || data.length === 0) {
    return null;
  }
  const entry = data[0];
  if (typeof entry.metadata === 'string') {
    try {
      entry.metadata = JSON.parse(entry.metadata);
    } catch (_) {}
  }
  return entry;
}

function isoWeekRangeUTC(yw) {
  const match = /^([0-9]{4})-W([0-9]{2})$/.exec(yw || '');
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - jan4Day));
  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    startUtc: start.toISOString(),
    endUtc: end.toISOString()
  };
}

async function getTop10(mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, points')
    .eq('month_key', mk);
  if (error) throw new Error(error.message || 'Failed to fetch events');
  return aggregateEventsByUser(data)
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : (a.display_name || '').localeCompare(b.display_name || '')))
    .slice(0, 10)
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

async function getTop10All() {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, points');
  if (error) throw new Error(error.message || 'Failed to fetch all events');
  return aggregateEventsByUser(data)
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : (a.display_name || '').localeCompare(b.display_name || '')))
    .slice(0, 10)
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

async function getTop10Week(yw) {
  const range = isoWeekRangeUTC(yw);
  if (!range) return [];
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, points, timestamp')
    .gte('timestamp', range.startUtc)
    .lt('timestamp', range.endUtc);
  if (error) throw new Error(error.message || 'Failed to load weekly events');
  return aggregateEventsByUser(data)
    .sort((a, b) => (b.points !== a.points ? b.points - a.points : (a.display_name || '').localeCompare(b.display_name || '')))
    .slice(0, 10)
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

async function getDistinctMonths() {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('month_key')
    .not('month_key', 'is', null);
  if (error) throw new Error(error.message || 'Failed to load months');
  const unique = Array.from(new Set((data || []).map((row) => row.month_key).filter(Boolean)));
  unique.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return unique;
}

async function getDistinctWeeks() {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('timestamp')
    .not('timestamp', 'is', null);
  if (error) throw new Error(error.message || 'Failed to load weeks');
  const set = new Set();
  for (const row of data || []) {
    const dt = row.timestamp ? new Date(row.timestamp) : null;
    if (!dt || Number.isNaN(dt.getTime())) continue;
    set.add(isoWeekKey(dt));
  }
  const list = Array.from(set);
  list.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return list;
}

async function monthsHandler(req, res) {
  try {
    const months = await getDistinctMonths();
    const current = monthKey();
    const unique = Array.from(new Set([current, ...months]));
    res.json({ months: unique, current });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load months' });
  }
}

async function weeksHandler(req, res) {
  try {
    const weeks = await getDistinctWeeks();
    const current = isoWeekKey();
    const unique = Array.from(new Set([current, ...weeks]));
    res.json({ weeks: unique, current });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load weeks' });
  }
}

async function buildWeeklySummaryText() {
  const mk = monthKey();
  const top = await getTop10(mk);
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`📣 อัปเดตอันดับรายสัปดาห์ (${today})`];
  if (!top.length) {
    lines.push(`ยังไม่มีคะแนนในเดือน ${mk} — เริ่มกันเลย! ✨`);
  } else {
    lines.push(`🏆 Top 10 เดือน ${mk}`);
    top.forEach((row, idx) => {
      lines.push(`${idx + 1}. ${row.display_name} — ${formatPoints(row.points)} คะแนน`);
    });
    lines.push('💪 เก็บโมเมนตัมกันต่อ!');
  }
  return lines.join('\n');
}

async function distinctUsersWithLink30d(mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, timestamp')
    .eq('month_key', mk)
    .ilike('command', '/link_30d');
  if (error) throw new Error(error.message || 'Failed to load /link_30d records');
  const map = new Map();
  for (const row of data || []) {
    if (!row.user_id) continue;
    const existing = map.get(row.user_id) || { user_id: row.user_id, display_name: row.display_name || '', timestamps: [] };
    if (row.timestamp) existing.timestamps.push(row.timestamp);
    if (row.display_name && row.display_name > existing.display_name) {
      existing.display_name = row.display_name;
    }
    map.set(row.user_id, existing);
  }
  return Array.from(map.values());
}

async function getSettlementEvent(command, userId, mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('id, points, detail')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', command)
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Failed to load settlement event');
  }
  return data ? { ...data, points: Number(data.points || 0) } : null;
}

function daysInMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

async function finalizeLink30dMonth(mk) {
  const users = await distinctUsersWithLink30d(mk);
  const dim = daysInMonthKey(mk);
  const results = [];
  for (const entry of users) {
    const set = new Set();
    for (const ts of entry.timestamps || []) {
      const dt = ts ? new Date(ts) : null;
      if (dt && !Number.isNaN(dt.getTime())) {
        set.add(localDateKey(dt));
      }
    }
    const days = set.size;
    const missing = Math.max(0, dim - days);
    const full = days > 0 && missing === 0;
    const existing = await getSettlementEvent('/link_30d_settle', entry.user_id, mk);
    const detail = `settlement ${mk}: ${days}/${dim} days${full ? ', full attendance bonus' : missing ? `, missing ${missing}` : ''}`;
    if (existing) {
      if (existing.points !== (full ? 1 : 0) || existing.detail !== detail) {
        await supabase
          .from('events')
          .update({ points: full ? 1 : 0, detail })
          .eq('id', existing.id);
      }
    } else if (full) {
      await insertEvent({
        user_id: entry.user_id,
        display_name: entry.display_name,
        command: '/link_30d_settle',
        detail,
        points: 1,
        month_key: mk
      });
    }
    results.push({
      user_id: entry.user_id,
      display_name: entry.display_name,
      days,
      missing,
      total_days: dim,
      points: full ? 1 : 0
    });
  }
  return { month: mk, settled: results };
}

function parseBookPages(detail, points) {
  if (!detail && Number.isFinite(points)) {
    const guess = roundTo(Number(points) / 0.01, 2);
    return Number.isFinite(guess) ? guess : 0;
  }
  if (typeof detail === 'string') {
    try {
      const json = JSON.parse(detail);
      if (json && Number.isFinite(json.pages)) return Number(json.pages);
    } catch (_) {
      const match = detail.match(/(-?\d+(?:\.\d+)?)/);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  } else if (detail && typeof detail === 'object' && Number.isFinite(detail.pages)) {
    return Number(detail.pages);
  }
  return 0;
}

async function distinctUsersInMonth(mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name')
    .eq('month_key', mk);
  if (error) throw new Error(error.message || 'Failed to load users');
  const map = new Map();
  for (const row of data || []) {
    if (!row.user_id) continue;
    const existing = map.get(row.user_id) || { user_id: row.user_id, display_name: row.display_name || '' };
    if (row.display_name && row.display_name > existing.display_name) {
      existing.display_name = row.display_name;
    }
    map.set(row.user_id, existing);
  }
  return Array.from(map.values());
}

async function sumBookPagesInMonth(userId, mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('detail, points')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .ilike('command', '/book');
  if (error) throw new Error(error.message || 'Failed to load /book events');
  let pages = 0;
  for (const row of data || []) {
    const value = parseBookPages(row.detail, row.points);
    if (Number.isFinite(value) && value > 0) {
      pages += value;
    }
  }
  return roundTo(pages, 2);
}

async function finalizeBookMonth(mk) {
  const users = await distinctUsersInMonth(mk);
  const settled = [];
  for (const user of users) {
    const pages = await sumBookPagesInMonth(user.user_id, mk);
    if (pages <= 300) continue;
    const existing = await getSettlementEvent('/book_bonus', user.user_id, mk);
    const detail = JSON.stringify({ pages });
    if (existing) {
      if (existing.points !== 1 || existing.detail !== detail) {
        await supabase
          .from('events')
          .update({ points: 1, detail })
          .eq('id', existing.id);
      }
    } else {
      await insertEvent({
        user_id: user.user_id,
        display_name: user.display_name,
        command: '/book_bonus',
        detail,
        points: 1,
        month_key: mk
      });
    }
    settled.push({ user_id: user.user_id, display_name: user.display_name, pages, points: 1 });
  }
  return { month: mk, settled };
}

async function finalizePlanUpdateMonth(mk) {
  return { month: mk, settled: [] };
}

function normalizeName(name) {
  return (typeof name === 'string' && name.trim()) ? name.trim() : 'สมาชิกไม่ระบุชื่อ';
}

function buildManualSettlementMessage(mk, linkResult, planResult, bookResult) {
  const lines = [`📊 สรุปคะแนนปลายเดือน ${mk}`];
  const linkBonuses = (linkResult?.settled || []).filter((r) => Number(r.points) > 0);
  const bookBonuses = (bookResult?.settled || []).filter((r) => Number(r.points) > 0);

  if (linkBonuses.length) {
    lines.push('🔗 โบนัส /link_30d ครบทุกวัน');
    linkBonuses.forEach((row) => {
      lines.push(`• ${normalizeName(row.display_name)} +${row.points}`);
    });
    lines.push('');
  }

  if (bookBonuses.length) {
    lines.push('📚 โบนัสอ่านหนังสือ (เกิน 300 หน้า)');
    bookBonuses.forEach((row) => {
      lines.push(`• ${normalizeName(row.display_name)} +${row.points} (อ่าน ${formatNumber(row.pages, 1)} หน้า)`);
    });
    lines.push('');
  }

  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 1) {
    lines.push('เดือนนี้ยังไม่มีโบนัสปลายเดือนเพิ่มเติม 😊');
  }
  return lines.join('\n');
}

const PLAN_UPDATE_MONTHLY_CAP = 4;

const messagePools = {
  inspire: [
    'วันนี้ทำได้ดีมากเลยนะ',
    'เติมพลังไว้ แล้วไปต่อกัน',
    'ก้าวเล็กๆ วันนี้ คือชัยชนะของพรุ่งนี้',
    'ทีมเราเชื่อในตัวคุณนะ ✨',
    'พักหายใจนิดนึง แล้วลุยต่อ'
  ],
  multiplier: [
    '{displayName} เก็บ {label} ครบครั้งที่ {count}!\n+{pts} คะแนน',
    'ความสม่ำเสมอมาส่งข่าว {label} #{count}\n+{pts} คะแนน',
    'ต่อเนื่องมากๆ {label} #{count}\n+{pts} คะแนน'
  ],
  connection: [
    'ยอดเยี่ยม! เพิ่มคอนเนคชั่น {n} คน\n+{pts} คะแนน',
    '{displayName} เชื่อมต่อเพิ่ม {n} รายชื่อ\n+{pts} คะแนน',
    'คอนเนคชั่นใหม่ {n} คน เก็บต่อเนื่องเลย\n+{pts} คะแนน'
  ],
  bm_product: [
    'รับรูป BM แล้ว ขอบคุณมาก!\n+{pts} คะแนน',
    'BM วันนี้สุดปัง ✨\n+{pts} คะแนน'
  ],
  bm_product_prompt: [
    'โปรดถ่ายรูปรายงานสำหรับ /bm_product แล้วส่งในแชทนี้นะ',
    'พิมพ์ /bm_product แล้วอย่าลืมส่งรูปตามในห้องนี้ด้วยนะ',
    'ส่งรูปรายงาน BM ในแชทนี้ได้เลย เพื่อบันทึก /bm_product ให้ครบ'
  ],
  schedule: [
    'ล็อกตารางเคสไว้แล้ว สุดยอดมาก!\n+{pts} คะแนน',
    'จองคิวเคสล่วงหน้าพร้อมหลักฐานครบ\n+{pts} คะแนน'
  ],
  schedule_prompt: [
    'โปรดนัดเคสและส่งรูปหลักฐานตามหลัง /schedule ในแชทนี้นะ',
    'พิมพ์ /schedule แล้วอย่าลืมส่งภาพยืนยันตารางเคสต่อเลยน้า'
  ],
  pack3: [
    'จัด 3 Pack เรียบร้อย\n+{pts} คะแนน',
    'Pack 3 มาแล้ว เดินเครื่องต่อเลย\n+{pts} คะแนน'
  ],
  old_member: [
    'ดูแลสมาชิกเก่าเรียบร้อย\n+{pts} คะแนน',
    'ลูกค้าเก่ายังแน่นแฟ้นนะ\n+{pts} คะแนน'
  ],
  sop: [
    'SOP สำเร็จ เยี่ยมมาก\n+{pts} คะแนน',
    'จัด SOP ให้ทีมแล้ว\n+{pts} คะแนน'
  ],
  use_product: [
    'บันทึกการใช้สินค้าแล้ว ขอบคุณสำหรับรูป\n+{pts} คะแนน',
    'ส่งรีวิวพร้อมรูปเรียบร้อย\n+{pts} คะแนน'
  ],
  follow_old: [
    'ติดตามลูกค้าเก่าเรียบร้อย\n+{pts} คะแนน',
    'ดูแลฐานเก่าอย่างดี\n+{pts} คะแนน'
  ],
  follow_new: [
    'ติดตามลูกค้าใหม่สำเร็จ\n+{pts} คะแนน',
    'คนใหม่ไม่หลุดมือเลย\n+{pts} คะแนน'
  ],
  plan_success: [
    'อัปเดตแผนสำเร็จ ดีมาก\n+{pts} คะแนน',
    'ความคืบหน้ามาแล้ว\n+{pts} คะแนน'
  ],
  plan_update_completed: [
    'เดือนนี้เก็บครบ +4 คะแนนจาก /plan_update แล้ว ไว้ลุยต่อเดือนหน้า 🌟',
    'คะแนน /plan_update เดือนนี้เต็มแล้ว รอเริ่มใหม่เดือนหน้านะ'
  ],
  plan_update_weekend_only: [
    'อัปเดตสัปดาห์ต้องส่งวันเสาร์หรืออาทิตย์นะ ลองกลับมาอีกครั้งช่วงสุดสัปดาห์ 😊',
    'เก็บ /plan_update ได้เฉพาะเสาร์-อาทิตย์นะคะ กลับมาส่งอีกทีตอน weekend นะ'
  ],
  plan_update_already_week: [
    'สัปดาห์นี้อัปเดตไว้แล้ว ลองเก็บคะแนนสัปดาห์หน้าได้เลย',
    'อัปเดตสัปดาห์นี้เรียบร้อยแล้ว เจอกันรอบหน้าค่ะ'
  ],
  link_need_photo: [
    'ขอรูปหลักฐานสำหรับ /link_30d วันนี้ด้วยนะ\n• {quote}',
    'พิมพ์ /link_30d แล้วอย่าลืมส่งรูปต่อเลยน้า\n• {quote}'
  ],
  link_received: [
    'ได้รับรูปแล้ว บันทึก /link_30d สำเร็จ\n+{pts} คะแนน\n• {quote}',
    'รูปมาครบแล้ว ขอบคุณมาก\n+{pts} คะแนน\n• {quote}'
  ],
  link_already: [
    'วันนี้บันทึก /link_30d ไว้แล้ว ขอบคุณมากนะ ✨',
    'วันนี้ส่งเรียบร้อยแล้ว เก็บพลังไว้ลุยต่อพรุ่งนี้นะ ✨'
  ],
  link_today_done_with_quote: [
    'วันนี้บันทึก /link_30d ไว้แล้ว ขอบคุณมากนะ ✨\n— {quote}',
    'ส่งครบแล้วสำหรับ /link_30d วันนี้\n— {quote}'
  ],
  unknown: [
    'ยังไม่รู้จักคำสั่งนี้ ลองพิมพ์ /help เพื่อดูรายการทั้งหมด',
    'คำสั่งนี้ยังไม่รองรับ ลอง /help ดูนะ'
  ],
  settle_dm_only: [
    'คำสั่ง /settle ใช้ได้เฉพาะแชทส่วนตัวกับบอทเท่านั้น',
    'โปรดใช้คำสั่ง /settle ในห้องแชทส่วนตัวกับบอทนะคะ'
  ],
  settle_need_secret: [
    'กรุณาระบุรหัสลับหลังคำสั่ง เช่น /settle รหัสลับ',
    'อย่าลืมใส่รหัสลับต่อท้ายคำสั่ง /settle ด้วยนะ (ตัวอย่าง: /settle รหัสลับ)'
  ],
  settle_wrong_secret: [
    'รหัสลับไม่ถูกต้อง',
    'รหัสลับยังไม่ตรง ลองตรวจสอบอีกครั้งนะ'
  ],
  settle_success: [
    'สรุปคะแนนปลายเดือน {month} ถูกส่งเรียบร้อยแล้ว',
    'ส่งสรุปคะแนนเดือน {month} ให้ทีมเรียบร้อยแล้ว ✨'
  ],
  connection_need_number: [
    'กรุณาระบุจำนวน เช่น /connection+3',
    'ใส่จำนวนคนเป็นตัวเลขด้วยนะ เช่น /connection+5'
  ],
  use_product_need_detail: [
    'กรุณาพิมพ์รีวิวสั้นๆ ต่อท้ายคำสั่ง เช่น /use_product ใช้สินค้า X แล้วรู้สึกสดชื่น',
    'อธิบายสั้นๆ ต่อท้าย /use_product ด้วยนะ เช่น /use_product ใช้สินค้าแล้วสดชื่นขึ้น'
  ],
  use_product_already: [
    'วันนี้บันทึก /use_product ไว้แล้ว (จำกัดวันละ 1 ครั้ง)',
    'วันนี้ส่งรายงานการใช้สินค้าไว้แล้วนะ เจอกันพรุ่งนี้ ✨'
  ],
  use_product_wait_photo: [
    'รับรายงานแล้ว โปรดส่งรูปประกอบ /use_product ภายในวันนี้ (จำกัดวันละ 1 ครั้ง)',
    'โอเคเลย! ส่งรูปประกอบ /use_product ต่อในวันนี้เพื่อรับคะแนนนะ'
  ],
  use_product_already_image: [
    'วันนี้ส่ง /use_product แล้ว ขอบคุณสำหรับรูป 😊',
    'ได้รับรูป /use_product วันนี้ไปแล้ว ขอบคุณมากนะ'
  ],
  book_need_number: [
    'กรุณาระบุจำนวนหน้าที่อ่าน เช่น /book 30',
    'อย่าลืมระบุจำนวนหน้า เช่น /book 25'
  ],
  book_invalid_number: [
    'จำนวนหน้าที่ระบุไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง',
    'ตัวเลขจำนวนหน้าไม่ถูกต้อง ลองพิมพ์ใหม่อีกครั้งนะ'
  ],
  book_success: [
    '📚 บันทึกการอ่าน {pages} หน้า ได้ +{points} คะแนน\n🎯 อ่านครบ 300 หน้าในเดือนนี้รับโบนัสปลายเดือน +1',
    '📖 วันนี้อ่าน {pages} หน้า รับไปเลย +{points} คะแนน\n🎯 เก็บครบ 300 หน้าในเดือนนี้ลุ้นโบนัสปลายเดือน +1'
  ],
  score_summary: [
    '💎 คะแนนของ {displayName} เดือน {month}\nรวม {total} คะแนน',
    'สรุปคะแนนเดือน {month} ของ {displayName}: {total} คะแนน 💎'
  ],
  rank_no_data: [
    'ยังไม่มีคะแนนเดือน {month}',
    'เดือน {month} ยังไม่มีใครเก็บคะแนนเลยนะ'
  ],
  rank_header: [
    '🏆 Top 3 เดือน {month}',
    '🏅 3 อันดับแรกของเดือน {month}'
  ]
};

function pickMsg(pool, vars = {}) {
  const template = pick(messagePools[pool]);
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined ? '' : value;
  });
}

function missingUserIdMessage(isGroupOrRoom) {
  if (isGroupOrRoom) {
    return 'ระบบยังไม่ได้รับ userId โปรดเพิ่มบอทเป็นเพื่อนหรือส่งคำสั่งในแชทส่วนตัวค่ะ';
  }
  return 'ไม่สามารถระบุผู้ใช้ได้ กรุณาลองใหม่อีกครั้ง';
}

async function safeGetDisplayName(uid, source = {}) {
  if (!uid) return 'คุณ';
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return 'คุณ';
  const headers = { Authorization: `Bearer ${token}` };
  const base = 'https://api.line.me/v2/bot';
  const attempts = [];
  if (source?.type === 'group' && source?.groupId) {
    attempts.push(`${base}/group/${source.groupId}/member/${uid}`);
  } else if (source?.type === 'room' && source?.roomId) {
    attempts.push(`${base}/room/${source.roomId}/member/${uid}`);
  }
  attempts.push(`${base}/profile/${uid}`);
  for (const url of attempts) {
    try {
      const res = await axios.get(url, { headers });
      const name = res?.data?.displayName;
      if (typeof name === 'string' && name.trim()) {
        return name.trim();
      }
    } catch (_) {}
  }
  return 'คุณ';
}

async function handleEvent(evt) {
  const text = (evt.message?.text || '').trim();
  if (!text.startsWith('/')) return;

  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const detail = parts.slice(1).join(' ');
  const subtype = (parts[1] || '').toLowerCase();
  const userId = evt?.source?.userId
    || evt?.source?.senderId
    || evt?.source?.memberId
    || evt?.source?.user?.id
    || evt?.source?.user?.userId
    || null;
  const sourceType = evt?.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';

  if (cmd === '/groupid' || cmd === '/group_id') {
    if (sourceType === 'group' && evt.source?.groupId) {
      await reply(evt.replyToken, `Group ID: ${evt.source.groupId}`);
      return;
    }
    if (sourceType === 'room' && evt.source?.roomId) {
      await reply(evt.replyToken, `Room ID: ${evt.source.roomId}`);
      return;
    }
    await reply(evt.replyToken, 'คำสั่งนี้ใช้ได้เฉพาะในห้องสนทนากลุ่มหรือ room เท่านั้น');
    return;
  }

  if (!userId) {
    await reply(evt.replyToken, missingUserIdMessage(isGroupOrRoom));
    return;
  }

  const mk = monthKey();
  let displayName = await safeGetDisplayName(userId, evt.source);
  if (!displayName || /\uFFFD/.test(displayName)) displayName = 'คุณ';

  const respondWithTotal = async (msg, pts) => {
    await replyWithInspireAndTotal(evt.replyToken, msg, displayName, userId, mk, pts);
  };

  const insertAndReply = async (command, pts, message, detailOverride) => {
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command,
      detail: (detailOverride ?? detail) || null,
      points: pts,
      month_key: mk
    });
    await respondWithTotal(message, pts);
  };

  if (cmd === '/help') {
    const base = publicBaseUrl();
    const lines = [
      '📚 คำสั่งที่ใช้ได้ (พิมพ์ตามนี้):',
      '/begin',
      '/beyond_dec',
      '/new_pride',
      '/new_member',
      '/pack3',
      '/bm_product',
      '/schedule (ส่งรูปตาม)',
      '/old_member',
      '/sop',
      '/connection+N',
      '/use_product <รายงาน> (ส่งรูปตาม)',
      '/plan_update',
      '/link_30d',
      '/book <จำนวนหน้า>',
      '/old_follow_up',
      '/new_follow_up',
      '/score',
      '/rank',
      '/rules',
      '',
      `อ่านกติกาเต็ม: ${base}/rules`
    ];
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  if (cmd === '/rules' || cmd === '/rule') {
    const url = `${publicBaseUrl()}/rules-image.png`;
    await replyImage(evt.replyToken, url);
    return;
  }

  if (cmd === '/settle' || cmd.startsWith('/settle+')) {
    if (sourceType !== 'user') {
      await reply(evt.replyToken, pickMsg('settle_dm_only'));
      return;
    }
    const args = [];
    if (cmd.startsWith('/settle+')) {
      const inline = parts[0].slice('/settle+'.length).trim();
      if (inline) {
        inline.split('+').forEach((token) => {
          const value = token.trim();
          if (value) args.push(value);
        });
      }
    }
    args.push(...parts.slice(1));
    if (!args.length) {
      await reply(evt.replyToken, pickMsg('settle_need_secret'));
      return;
    }
    let targetMonth = monthKey();
    if (/^\d{4}-\d{2}$/.test(args[0])) {
      targetMonth = args.shift();
    }
    const secret = args.join(' ').trim();
    if (!secret) {
      await reply(evt.replyToken, pickMsg('settle_need_secret'));
      return;
    }
    if (secret !== manualSettleSecret) {
      await reply(evt.replyToken, pickMsg('settle_wrong_secret'));
      return;
    }
    try {
      const linkResult = await finalizeLink30dMonth(targetMonth);
      const planResult = await finalizePlanUpdateMonth(targetMonth);
      const bookResult = await finalizeBookMonth(targetMonth);
      const summary = buildManualSettlementMessage(targetMonth, linkResult, planResult, bookResult);
      await push(summary);
      await reply(evt.replyToken, pickMsg('settle_success', { month: targetMonth }));
    } catch (err) {
      await reply(evt.replyToken, `เกิดข้อผิดพลาด: ${err?.message || err}`);
    }
    return;
  }

  if (cmd === '/score') {
    const sum = await sumUserMonth(userId, mk);
    await reply(evt.replyToken, pickMsg('score_summary', {
      displayName,
      month: mk,
      total: formatPoints(sum)
    }));
    return;
  }

  if (cmd === '/rank') {
    const top = await getTop10(mk);
    if (!top.length) {
      await reply(evt.replyToken, pickMsg('rank_no_data', { month: mk }));
      return;
    }
    const header = pickMsg('rank_header', { month: mk }) || `🏆 Top 3 เดือน ${mk}`;
    const lines = [header];
    top.slice(0, 3).forEach((row, idx) => {
      lines.push(`${idx + 1}. ${row.display_name} — ${formatPoints(row.points)} คะแนน`);
    });
    lines.push('');
    lines.push(`ดู Top 10 แบบเรียลไทม์: ${publicBaseUrl()}/`);
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  if (cmd.startsWith('/connection+')) {
    const match = cmd.match(/\/connection\+(\d+(?:\.\d+)?)/);
    const count = match ? Number(match[1]) : 0;
    const pts = count * 0.1;
    if (!Number.isFinite(count) || count <= 0) {
      await reply(evt.replyToken, pickMsg('connection_need_number'));
      return;
    }
    const msg = pickMsg('connection', {
      displayName,
      n: formatNumber(count),
      pts: `+${formatPoints(pts)}`
    });
    await insertAndReply('/connection', pts, msg);
    return;
  }

  const multiplierCommands = {
    '/begin': { label: 'Begin Onsite', base: 1 },
    '/beyond_dec': { label: 'Beyond (ธ.ค.)', base: 2 },
    '/new_pride': { label: 'New Pride', base: 2 },
    '/new_member': { label: 'สมาชิกใหม่สมัคร + ซื้อครบ', base: 1 }
  };

  if (multiplierCommands[cmd]) {
    const count = await countUserCommandThisMonth(userId, cmd, mk);
    const pts = multiplierCommands[cmd].base * Math.pow(2, count);
    const msg = pickMsg('multiplier', {
      displayName,
      label: multiplierCommands[cmd].label,
      count: count + 1,
      pts: `+${formatPoints(pts)}`
    });
    await insertAndReply(cmd, pts, msg);
    return;
  }

  if (cmd === '/pack3' || cmd === '/old_member' || cmd === '/sop') {
    const pts = (await loadRulePoints(cmd)) ?? (cmd === '/pack3' ? 4 : cmd === '/sop' ? 2 : 1);
    const key = cmd.slice(1);
    const msg = pickMsg(key, { displayName, pts: `+${formatPoints(pts)}` });
    await insertAndReply(cmd, pts, msg);
    return;
  }

  if (cmd === '/schedule') {
    await upsertPending(userId, '/schedule');
    await reply(evt.replyToken, pickMsg('schedule_prompt'));
    return;
  }

  if (cmd === '/bm_product') {
    await upsertPending(userId, '/bm_product');
    await reply(evt.replyToken, pickMsg('bm_product_prompt'));
    return;
  }

  if (cmd === '/use_product') {
    if (!detail) {
      await reply(evt.replyToken, pickMsg('use_product_need_detail'));
      return;
    }
    if (await hasUseProductToday(userId)) {
      await reply(evt.replyToken, pickMsg('use_product_already'));
      return;
    }
    await upsertPending(userId, '/use_product', { report: detail });
    await reply(evt.replyToken, pickMsg('use_product_wait_photo'));
    return;
  }

  if (cmd === '/plan_update') {
    const events = await listPlanUpdateEvents(userId, mk);
    const awarded = events.filter((row) => Number(row.points) > 0);
    if (awarded.length >= PLAN_UPDATE_MONTHLY_CAP) {
      await reply(evt.replyToken, pickMsg('plan_update_completed'));
      return;
    }
    if (awarded.length === 0) {
      const message = pickMsg('plan_success', { pts: '+1' });
      await insertAndReply('/plan_update', 1, `${message}\n📊 ความคืบหน้า 1/${PLAN_UPDATE_MONTHLY_CAP}`);
      return;
    }
    const now = new Date();
    if (!isWeekend(now)) {
      await reply(evt.replyToken, pickMsg('plan_update_weekend_only'));
      return;
    }
    const currentWeek = isoWeekKey(now);
    const weekendUpdates = awarded.slice(1);
    const alreadyWeek = weekendUpdates.some((row) => isoWeekKey(new Date(row.timestamp)) === currentWeek);
    if (alreadyWeek) {
      await reply(evt.replyToken, pickMsg('plan_update_already_week'));
      return;
    }
    const progress = `${awarded.length + 1}/${PLAN_UPDATE_MONTHLY_CAP}`;
    const message = pickMsg('plan_success', { pts: '+1' });
    await insertAndReply('/plan_update', 1, `${message}\n📊 ความคืบหน้า ${progress}`);
    return;
  }

  if (cmd === '/link_30d') {
    if (await hasLink30dToday(userId)) {
      await reply(evt.replyToken, pickMsg('link_already'));
      return;
    }
    await upsertPending(userId, '/link_30d');
    const quote = pick(messagePools.inspire) || '';
    await reply(evt.replyToken, pickMsg('link_need_photo', { quote }));
    return;
  }

  if (cmd === '/old_follow_up' || cmd === '/new_follow_up') {
    const pts = cmd === '/old_follow_up' ? 1 : 2;
    const msg = pickMsg(cmd === '/old_follow_up' ? 'follow_old' : 'follow_new', {
      displayName,
      pts: `+${formatPoints(pts)}`
    });
    await insertAndReply(cmd, pts, msg);
    return;
  }

  if (cmd === '/book') {
    const raw = parts.slice(1).join(' ').trim();
    let pages = 10;
    if (raw) {
      const match = raw.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          pages = roundTo(parsed, 2);
        }
      }
    }
    if (!Number.isFinite(pages) || pages <= 0) {
      await reply(evt.replyToken, pickMsg('book_need_number'));
      return;
    }
    const points = roundTo(pages * 0.01, 2);
    if (points <= 0) {
      await reply(evt.replyToken, pickMsg('book_invalid_number'));
      return;
    }
    const detailPayload = JSON.stringify({ pages, raw: raw || null });
    const message = pickMsg('book_success', {
      pages: formatNumber(pages, 1),
      points: formatPoints(points)
    }) || `📚 บันทึกการอ่าน ${formatNumber(pages, 1)} หน้า ได้ +${formatPoints(points)} คะแนน\n🎯 อ่านครบ 300 หน้าในเดือนนี้รับโบนัสปลายเดือน +1`;
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command: '/book',
      detail: detailPayload,
      points,
      month_key: mk
    });
    await respondWithTotal(message, points);
    return;
  }

  if (!isGroupOrRoom) {
    await reply(evt.replyToken, pickMsg('unknown'));
  }
}

async function handleImageEvent(evt) {
  const userId = evt?.source?.userId
    || evt?.source?.senderId
    || evt?.source?.memberId
    || evt?.source?.user?.id
    || evt?.source?.user?.userId
    || null;
  const sourceType = evt?.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';
  if (!userId) {
    await reply(evt.replyToken, missingUserIdMessage(isGroupOrRoom));
    return;
  }
  const mk = monthKey();
  const imageId = evt?.message?.id || 'image';
  const displayName = await safeGetDisplayName(userId, evt.source);

  const pendingLink = await consumePending(userId, '/link_30d');
  if (pendingLink) {
    if (await hasLink30dToday(userId)) {
      const quote = pick(messagePools.inspire) || '';
      await reply(evt.replyToken, pickMsg('link_today_done_with_quote', { quote }));
      return;
    }
    const pts = (await loadRulePoints('/link_30d', 'success')) ?? 0.1;
    const formattedPts = formatPoints(pts);
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command: '/link_30d',
      detail: `evidence:${imageId}`,
      points: pts,
      month_key: mk
    });
    const quote = pick(messagePools.inspire) || '';
    await reply(evt.replyToken, pickMsg('link_received', { quote, pts: formattedPts }));
    return;
  }

  const pendingSchedule = await consumePending(userId, '/schedule');
  if (pendingSchedule) {
    const pts = (await loadRulePoints('/schedule', '')) ?? 1;
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command: '/schedule',
      detail: `evidence:${imageId}`,
      points: pts,
      month_key: mk
    });
    const msg = pickMsg('schedule', { displayName, pts: `+${formatPoints(pts)}` });
    await replyWithInspireAndTotal(evt.replyToken, msg, displayName, userId, mk, pts);
    return;
  }

  const pendingBm = await consumePending(userId, '/bm_product');
  if (pendingBm) {
    const pts = (await loadRulePoints('/bm_product', '')) ?? 1;
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command: '/bm_product',
      detail: `evidence:${imageId}`,
      points: pts,
      month_key: mk
    });
    const msg = pickMsg('bm_product', { displayName, pts: `+${formatPoints(pts)}` });
    await replyWithInspire(evt.replyToken, msg, displayName);
    return;
  }

  const pendingUse = await consumePending(userId, '/use_product');
  if (pendingUse) {
    if (await hasUseProductToday(userId)) {
      await reply(evt.replyToken, pickMsg('use_product_already_image'));
      return;
    }
    const pts = (await loadRulePoints('/use_product', '')) ?? 0.1;
    const report = pendingUse.metadata?.report || '';
    const detailParts = [];
    if (report) detailParts.push(`report:${report}`);
    detailParts.push(`evidence:${imageId}`);
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command: '/use_product',
      detail: detailParts.join('|'),
      points: pts,
      month_key: mk
    });
    const msg = pickMsg('use_product', { displayName, pts: `+${formatPoints(pts)}` });
    await replyWithInspire(evt.replyToken, msg, displayName);
    return;
  }

  if (!isGroupOrRoom) {
    await reply(evt.replyToken, 'หากเป็นรูปประกอบคะแนน โปรดพิมพ์คำสั่งก่อน เช่น /schedule, /bm_product, /use_product หรือ /link_30d');
  }
}

async function top10Handler(req, res) {
  try {
    const scope = (req.query?.scope || '').toLowerCase();
    const ym = (req.query?.ym || '').toLowerCase();
    const yw = (req.query?.yw || '').toUpperCase();
    if (scope === 'week' || yw) {
      const targetWeek = yw || isoWeekKey();
      const data = await getTop10Week(targetWeek);
      res.json({ meta: { scope: 'week', yw: targetWeek }, data });
      return;
    }
    if (scope === 'all' || ym === 'all') {
      const data = await getTop10All();
      res.json({ meta: { scope: 'all' }, data });
      return;
    }
    const targetMonth = /^\d{4}-\d{2}$/.test(ym) ? ym : monthKey();
    const data = await getTop10(targetMonth);
    res.json({ meta: { scope: 'month', ym: targetMonth }, data });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load leaderboard' });
  }
}

module.exports = {
  handleEvent,
  handleImageEvent,
  top10Handler,
  buildWeeklySummaryText,
  push,
  monthsHandler,
  weeksHandler,
  finalizeLink30dMonth,
  finalizeBookMonth,
  finalizePlanUpdateMonth
};
