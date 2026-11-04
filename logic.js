const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

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

async function ensureDailyAnnouncementsTable() {
  const check = await supabase
    .from('daily_announcements')
    .select('chat_id', { head: true, count: 'exact' })
    .limit(1);

  if (!check.error) return;

  const msg = `${check.error?.message || check.error?.details || ''}`.toLowerCase();
  if (!msg.includes('daily_announcements') || (!msg.includes('does not exist') && !msg.includes('schema cache'))) {
    throw new Error(`Failed to access daily_announcements table: ${check.error?.message || check.error}`);
  }

  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error('Supabase table "daily_announcements" is missing. Provide SUPABASE_DB_URL (or DATABASE_URL) or create it from schema.sql');
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
      CREATE TABLE IF NOT EXISTS public.daily_announcements (
        chat_id TEXT NOT NULL,
        date_key DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (chat_id, date_key)
      );
    `);
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
  }

  const verify = await supabase
    .from('daily_announcements')
    .select('chat_id', { head: true, count: 'exact' })
    .limit(1);
  if (verify.error) {
    throw new Error(`Daily announcements table created but still not accessible: ${verify.error?.message || verify.error}`);
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
  await ensureDailyAnnouncementsTable();
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

const dailyAnnouncementsByReplyToken = new Map();

async function replyMessages(replyToken, messages) {
  if (!replyToken || !Array.isArray(messages) || !messages.length) return;
  const dailyAnnouncements = dailyAnnouncementsByReplyToken.get(replyToken) || [];
  const outgoingMessages = dailyAnnouncements.length
    ? [...messages, ...dailyAnnouncements.map((text) => ({ type: 'text', text }))]
    : messages;
  dailyAnnouncementsByReplyToken.delete(replyToken);
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: outgoingMessages
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

function composeInspireText(text) {
  const quote = pick(messagePools.inspire) || '';
  if (!quote) return text;
  return `${text}\n✨ ฝากไว้ให้คิด: “${quote}”`;
}

async function replyWithInspire(replyToken, text) {
  await reply(replyToken, composeInspireText(text));
}

async function replyWithInspireAndTotal(replyToken, baseMessage, displayName, userId, mk, points, options = {}) {
  const lines = [];
  const shouldAnnounceRank = options.announceRankChange !== false;
  let messageWithTotal = baseMessage;
  let rankingAfter;

  if (Number.isFinite(points) && points !== 0 && mk) {
    try {
      rankingAfter = await getMonthRanking(mk);
      const self = rankingAfter.find((r) => r.user_id === userId);
      if (self) {
        messageWithTotal = `${baseMessage}\n💎 คะแนนสะสมรวม: ${formatPoints(self.points)} คะแนน`;
        if (shouldAnnounceRank) {
          const notice = buildRankChangeNotice(rankingAfter, userId, displayName, points);
          if (notice) lines.push(notice);
        }
      }
    } catch (err) {
      console.warn('Rank announcement unavailable:', err?.message || err);
    }
  }

  if (messageWithTotal === baseMessage && Number.isFinite(points) && points !== 0) {
    const totalFallback = await sumUserMonth(userId, mk);
    messageWithTotal = `${baseMessage}\n💎 คะแนนสะสมรวม: ${formatPoints(totalFallback)} คะแนน`;
  }

  lines.unshift(messageWithTotal);
  await replyWithInspire(replyToken, lines.filter(Boolean).join('\n'));
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
    const current = map.get(id) || { user_id: id, display_name: '', points: 0, latest: null };
    const name = row.display_name || '';
    const ts = row.timestamp ? Number(new Date(row.timestamp)) : null;
    if (ts !== null && Number.isFinite(ts)) {
      if (current.latest === null || ts >= current.latest) {
        current.display_name = name || current.display_name;
        current.latest = ts;
      }
    } else if (!current.display_name && name) {
      current.display_name = name;
      current._latestTs = ts;
    } else if (!current.display_name) {
      current.display_name = row.user_id || '';
    }
    current.points += Number(row.points || 0);
    map.set(id, current);
  }
  return Array.from(map.values()).map(({ latest, ...rest }) => rest);
}

function sortEntries(rows = []) {
  return rows.sort((a, b) => (b.points !== a.points ? b.points - a.points : (a.display_name || '').localeCompare(b.display_name || '')));
}

function addDenseRanks(sortedRows = []) {
  let lastPoints = null;
  let currentRank = 0;
  return sortedRows.map((row, idx) => {
    if (lastPoints === null || row.points < lastPoints) {
      currentRank = idx + 1;
      lastPoints = row.points;
    }
    return { ...row, rank: currentRank };
  });
}

function rankAndLimit(rows = [], limit) {
  const ranked = addDenseRanks(sortEntries(rows));
  if (!limit || limit <= 0) return ranked;
  return ranked.slice(0, limit);
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

async function insertEvents(events) {
  await dbReady;
  const payloads = events.map((event) => ({
    user_id: event.user_id,
    display_name: event.display_name,
    command: event.command,
    detail: event.detail ?? null,
    points: roundTo(event.points, 2),
    month_key: event.month_key ?? monthKey()
  }));
  const attempt = async () => {
    const { error } = await supabase.from('events').insert(payloads);
    if (error) throw error;
  };
  try {
    await attempt();
  } catch (err) {
    const msg = `${err?.message || err?.error_description || err?.details || ''}`.toLowerCase();
    const looksNumeric = msg.includes('integer') || msg.includes('numeric');
    if (!looksNumeric) throw err;
    await ensureEventsPointsNumericType();
    await attempt();
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

const FOUR_S_PHOTO_COMMANDS = new Set([
  '/ppv',
  '/s1',
  '/for',
  '/opp',
  '/abo',
  '/m',
  '/s2',
  '/s4'
]);

async function queueFourSPhoto(userId, command, evt, metadata = {}) {
  await dbReady;
  const messageId = evt?.message?.id || `${Date.now()}-${Math.random()}`;
  const entry = {
    user_id: userId,
    command: `${command}:${messageId}`,
    date_key: localDateKey(),
    month_key: monthKey(),
    metadata: JSON.stringify({ ...metadata, command }),
    created_at: new Date().toISOString()
  };
  const { error } = await supabase.from('pending').insert(entry);
  if (error) throw new Error(error.message || `Failed to queue ${command} photo`);
}

async function consumeNextFourSPhoto(userId) {
  await dbReady;
  const { data, error } = await supabase
    .from('pending')
    .select('user_id, command, date_key, month_key, metadata, created_at')
    .eq('user_id', userId)
    .eq('date_key', localDateKey())
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message || 'Failed to load pending 4S photos');

  for (const entry of data || []) {
    let metadata = {};
    try {
      metadata = typeof entry.metadata === 'string'
        ? JSON.parse(entry.metadata)
        : (entry.metadata || {});
    } catch (err) {
      console.warn('Invalid pending 4S metadata:', err?.message || err);
      continue;
    }
    if (!FOUR_S_PHOTO_COMMANDS.has(metadata.command)) continue;

    const { data: removed, error: removeError } = await supabase
      .from('pending')
      .delete()
      .eq('user_id', entry.user_id)
      .eq('command', entry.command)
      .eq('date_key', entry.date_key)
      .select('command');
    if (removeError) throw new Error(removeError.message || 'Failed to consume pending 4S photo');
    if (!removed?.length) continue;
    return { ...entry, metadata };
  }
  return null;
}

async function hasCommandToday(userId, command) {
  await dbReady;
  const today = localDateKey();
  const mk = monthKey();
  const { data, error } = await supabase
    .from('events')
    .select('timestamp')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .eq('command', command)
    .order('timestamp', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message || `Failed to check ${command}`);
  return (data || []).some((row) => localDateKey(new Date(row.timestamp)) === today);
}

async function sumUserMonthPpv(userId, mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('detail')
    .eq('user_id', userId)
    .eq('month_key', mk)
    .eq('command', '/ppv');
  if (error) throw new Error(error.message || 'Failed to sum monthly PV');
  const total = (data || []).reduce((sum, row) => {
    const match = String(row.detail || '').match(/^pv:(\d+(?:\.\d+)?)(?:\||$)/);
    return match ? sum + Number(match[1]) : sum;
  }, 0);
  return roundTo(total, 2);
}

function ppvMilestonesCrossed(previousPpv, currentPpv) {
  const milestones = [
    { ppv: 600, points: 1 },
    { ppv: 3000, points: 4 },
    { ppv: 6000, points: 5 },
    { ppv: 9000, points: 5 },
    { ppv: 12000, points: 5 },
    { ppv: 15000, points: 5 }
  ];
  return milestones.filter((milestone) => previousPpv < milestone.ppv && currentPpv >= milestone.ppv);
}

async function getMonthEvents(mk) {
  await dbReady;
  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('events')
      .select('id, user_id, display_name, command, points, timestamp')
      .eq('month_key', mk)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message || 'Failed to fetch events');

    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
    offset += pageSize;
  }
}

function monthlyCountdownStatus(events, eventId = null, eventCommand = '') {
  const productEvents = events.filter((event) => String(event.command || '').trim().toLowerCase() === '/s1');
  const businessEvents = events.filter((event) => {
    const command = String(event.command || '').trim().toLowerCase();
    return command === '/s2' || command === '/opp onsite';
  });
  const command = String(eventCommand || '').trim().toLowerCase();
  const eventList = command === '/s1' ? productEvents
    : command === '/s2' || command === '/opp onsite' ? businessEvents
      : [];
  const eventIndex = eventId === null
    ? -1
    : eventList.findIndex((event) => String(event.id) === String(eventId));
  const productCasesDone = Math.min(100, productEvents.length);
  const businessCasesDone = Math.min(100, businessEvents.length);
  const productPhase = productCasesDone >= 50 ? 2 : 1;
  const businessPhase = businessCasesDone >= 50 ? 2 : 1;

  return {
    productCasesDone,
    businessCasesDone,
    productPhase,
    businessPhase,
    productCasesRemaining: Math.max(0, (productPhase === 1 ? 50 : 100) - productCasesDone),
    businessCasesRemaining: Math.max(0, (businessPhase === 1 ? 50 : 100) - businessCasesDone),
    decremented: eventIndex >= 0 && eventIndex < 100
  };
}

async function getMonthlyCountdownStatus(mk, eventId = null, eventCommand = '') {
  return monthlyCountdownStatus(await getMonthEvents(mk), eventId, eventCommand);
}

function formatCountdownStatus(status) {
  const productTarget = status.productPhase === 1 ? 50 : 100;
  const businessTarget = status.businessPhase === 1 ? 50 : 100;
  const productPhaseLabel = status.productPhase === 1 ? 'เฟส 1' : 'เฟส 2 โบนัส';
  const businessPhaseLabel = status.businessPhase === 1 ? 'เฟส 1' : 'เฟส 2 โบนัส';
  return `📦 เคสสินค้า: ${status.productCasesDone}/${productTarget} (${productPhaseLabel}) เหลือ ${status.productCasesRemaining}\n💼 เคสเล่าธุรกิจ: ${status.businessCasesDone}/${businessTarget} (${businessPhaseLabel}) เหลือ ${status.businessCasesRemaining}`;
}

async function getTop10(mk, limit = 10) {
  const data = await getMonthEvents(mk);
  const scoreCommandCategories = new Map([
    ['/ppv', 's1'], ['/s1', 's1'],
    ['/for', 's2'], ['/opp', 's2'], ['/opp online', 's2'], ['/opp onsite', 's2'],
    ['/abo', 's2'], ['/m', 's2'], ['/s2', 's2'],
    ['/pin', 's3'],
    ['/link', 's4'], ['/book', 's4'], ['/product', 's4'], ['/ct', 's4'],
    ['/follow', 's4'], ['/hm', 's4'], ['/s4', 's4']
  ]);
  const pointsByUser = new Map();
  for (const row of data || []) {
    const command = String(row.command || '').trim().toLowerCase();
    const category = scoreCommandCategories.get(command);
    if (!category) continue;
    const points = pointsByUser.get(row.user_id) || { s1: 0, s2: 0, s3: 0, s4: 0 };
    points[category] += Number(row.points || 0);
    pointsByUser.set(row.user_id, points);
  }
  return rankAndLimit(aggregateEventsByUser(data).map((row) => ({
    ...row,
    s1: roundTo(pointsByUser.get(row.user_id)?.s1 || 0, 2),
    s2: roundTo(pointsByUser.get(row.user_id)?.s2 || 0, 2),
    s3: roundTo(pointsByUser.get(row.user_id)?.s3 || 0, 2),
    s4: roundTo(pointsByUser.get(row.user_id)?.s4 || 0, 2)
  })), limit)
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

async function getMonthRanking(mk) {
  const data = await getMonthEvents(mk);
  return rankAndLimit(aggregateEventsByUser(data))
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim() || 'สมาชิก';
}

function buildRankChangeNotice(rankingAfter, userId, displayName, addedPoints) {
  if (!Number.isFinite(addedPoints) || addedPoints <= 0) return '';
  const selfIdx = rankingAfter.findIndex((r) => r.user_id === userId);
  if (selfIdx === -1) return '';
  const self = rankingAfter[selfIdx];

  const beforeRows = rankingAfter
    .map((row) => {
      if (row.user_id !== userId) return row;
      const previous = roundTo(row.points - addedPoints, 2);
      if (previous <= 0) return null;
      return { ...row, points: previous };
    })
    .filter(Boolean);

  const rankingBefore = rankAndLimit(beforeRows);
  const before = rankingBefore.find((r) => r.user_id === userId);
  const beforeRank = before?.rank ?? null;
  const afterRank = self.rank;

  if (beforeRank !== null && afterRank >= beforeRank) return '';

  const lines = [];
  const fromText = beforeRank ? `อันดับ ${beforeRank}` : 'นอกตาราง';
  lines.push('📈 อันดับขยับ!');
  lines.push(`• จาก ${fromText} ➜ อันดับ ${afterRank} (+${formatPoints(addedPoints)} คะแนน)`);

  const above = rankingAfter[selfIdx - 1];
  const below = rankingAfter[selfIdx + 1];
  const neighborLines = [];
  if (above) {
    neighborLines.push(`⬆️ ${above.rank}. ${normalizeName(above.display_name || above.user_id)} — ${formatPoints(above.points)} คะแนน`);
  }
  if (below) {
    neighborLines.push(`⬇️ ${below.rank}. ${normalizeName(below.display_name || below.user_id)} — ${formatPoints(below.points)} คะแนน`);
  }
  if (neighborLines.length) {
    lines.push('');
    lines.push('คู่แข่งใกล้เคียง:');
    lines.push(...neighborLines);
  }

  return lines.join('\n');
}

function deriveMonthKey(row) {
  if (/^\d{4}-\d{2}$/.test(String(row.month_key || ''))) return row.month_key;
  const timestamp = new Date(row.timestamp);
  return Number.isNaN(timestamp.getTime()) ? null : monthKey(timestamp);
}

async function getDistinctMonths() {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('month_key, timestamp');
  if (error) throw new Error(error.message || 'Failed to load months');
  const unique = Array.from(new Set((data || [])
    .map((row) => deriveMonthKey(row))
    .filter(Boolean)));
  unique.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return unique;
}

async function monthsHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const months = await getDistinctMonths();
    const current = monthKey();
    const unique = Array.from(new Set([current, ...months]));
    res.json({ months: unique, current });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load months' });
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

const messagePools = {
  countdown_cheer: [
    'เยี่ยมครับ อีกหนึ่งเคสที่ทุกคนช่วยกันพาภารกิจเข้าใกล้เป้าหมาย',
    'ขยับไปอีกหนึ่งก้าวแล้วครับ ทำต่อทีละเคส เดี๋ยวครบเอง',
    'ยอดลดลงอีกหนึ่งแล้วครับ พลังทีมดีแบบนี้ กาแฟยังต้องยอมแพ้',
    'อีกหนึ่งเคสผ่านไปด้วยดีครับ ความสำเร็จชอบทีมที่ช่วยกันลงมือ',
    'เก่งมากครับ เป้าหมายไม่ได้ใกล้ขึ้นเอง แต่ทีมเราช่วยกันทำให้ใกล้ขึ้น',
    'อีกหนึ่งเคสในกระเป๋าความสำเร็จครับ ค่อย ๆ เก็บ เดี๋ยวครบ 50 แบบไม่รู้ตัว',
    'เดินหน้าอีกหนึ่งแล้วครับ วันนี้ทีมเราไม่ได้แค่คุยเรื่องแผน แต่ทำให้เห็นด้วย',
    'เยี่ยมเลยครับ หนึ่งเคสอาจดูเล็ก แต่พอช่วยกันหลายคนก็กลายเป็นเรื่องใหญ่',
    'อีกหนึ่งความคืบหน้าครับ ทำต่อเนื่องไว้ เป้าหมายจะได้ไม่ต้องรอเรานาน',
    'ลดไปอีกหนึ่งเคสแล้วครับ ทีมเวิร์กดีขนาดนี้ เป้าหมายมีหนาวแน่นอน',
    'อีกหนึ่งเคสแล้วครับ อย่ารอให้ Countdown ทักมาถามว่า “ยังทำภารกิจกันอยู่ไหม?”',
    'ยอดลดแล้วครับ แผนดีเป็นจุดเริ่ม ลงมือทำคือจุดที่ปฏิทินเริ่มประทับใจ',
    'อีกเคสเดียวที่เราชนะความขี้เกียจครับ วันนี้ความขี้เกียจขอพักร้อนแล้ว',
    'ภารกิจคืบหน้าอีกนิดครับ ค่อย ๆ ทำ อย่าค่อย ๆ ผัด เดี๋ยวสิ้นเดือนจะลุ้นเกินไป',
    'เยี่ยมครับ ทำก่อนค่อยฉลองก็ได้ แต่ถ้าฉลองก่อน อย่าลืมกลับมาทำต่อด้วยนะ',
    'อีกหนึ่งเคสครับ เป้าหมายไม่กัด แต่ถ้าปล่อยไว้นานอาจมองแรงนิดหนึ่ง',
    'ทีมช่วยกันดีมากครับ งานไม่เดินเอง แต่กาแฟอาจเดินมาหาเราได้',
    'ยอดลงอีกแล้วครับ หลักฐานชัดเจนกว่าคำว่า “เดี๋ยวทำ” เสมอ',
    'ความคืบหน้ามาแล้วครับ วันนี้ชนะทั้งภารกิจและปุ่มเลื่อนปลุก',
    'อีกหนึ่งเคสครับ ทำทีละนิดดีกว่ารอฤกษ์ดีจนฤกษ์เปลี่ยนเดือน',
    'เก่งมากครับ ถ้าความตั้งใจแปลงเป็นคะแนนได้ วันนี้ทีมเราคะแนนเต็มใจไปแล้ว'
  ],
  inspire: [
    'อย่ารอให้มั่นใจแล้วค่อยเริ่ม บางทีความมั่นใจเขาก็มาตอนเห็นเราทำไปแล้วนี่แหละ',
    'ฝันให้ไกลได้ แต่อย่าลืมตื่นมาลงมือทำด้วยนะ',
    'คนเก่งไม่ใช่คนที่ไม่เคยพลาด แต่คือคนที่พลาดแล้วไม่สมัครเป็นลูกค้าประจำของความผิดพลาดเดิม',
    'ชีวิตไม่มีทางลัด แต่มีทางที่เดินแล้วไม่ต้องย้อนกลับไปแก้ ถ้าคิดให้รอบก่อนเริ่ม',
    'ก้าวช้าก็ยังดีกว่ายืนบ่นว่าทำไมถึงยังไม่ถึง',
    'อย่าเอาวันที่แย่วันเดียวไปตัดสินทั้งชีวิต ชีวิตยังมีวันพรุ่งนี้ให้แก้มือ',
    'ทำวันนี้ให้ดีที่สุด ที่เหลือพรุ่งนี้ค่อยว่ากัน แต่พรุ่งนี้อย่าลืมมาจริง ๆ ล่ะ',
    'ความสำเร็จชอบคนลงมือทำ ส่วนข้ออ้างชอบคนที่มีเวลาว่างให้มัน',
    'เหนื่อยได้ พักได้ แต่อย่าเพิ่งลาออกจากความฝันตอนที่แค่ต้องการนอน',
    'อย่าเปรียบเทียบจุดเริ่มต้นของเรากับตอนที่คนอื่นเขาไปถึงครึ่งทางแล้ว',
    'ประสบการณ์สอนเราเก่งมาก บางบทเรียนก็เก็บค่าเทอมแพงไปหน่อย',
    'ถ้าแผนแรกยังไม่สำเร็จ ไม่ได้แปลว่าฝันผิด บางทีแค่ต้องเปลี่ยนวิธี ไม่ใช่เปลี่ยนเป้าหมาย',
    'พูดให้น้อยลงนิด ทำให้มากขึ้นหน่อย เดี๋ยวผลงานช่วยแนะนำตัวเราเอง',
    'ความสม่ำเสมออาจไม่หวือหวา แต่เป็นคนรู้จักที่ไว้ใจได้ที่สุดของความสำเร็จ',
    'อยากไปให้ไกล อย่าเอาแต่ถามว่าทางยากไหม ลองถามว่าก้าวต่อไปคืออะไร',
    'คนเราพลาดกันได้ แต่อย่าพลาดซ้ำจนความผิดพลาดเริ่มเรียกเราว่าลูกพี่',
    'วันที่ยังไม่มีใครเห็นความพยายาม ก็ทำต่อไปก่อน วันหนึ่งผลลัพธ์จะพูดเสียงดังกว่าเรา',
    'อย่ากลัวการเริ่มใหม่ เริ่มใหม่วันนี้ยังดีกว่ารอให้วันจันทร์ที่สมบูรณ์แบบมาถึง',
    'เงินซื้อความสุขไม่ได้ทั้งหมด แต่ช่วยให้เรามีเวลาหาความสุขโดยไม่ต้องกังวลค่ากับข้าว',
    'ความสำเร็จไม่ได้เกิดจากโชคอย่างเดียว โชคมักหาเจอคนที่เตรียมตัวไว้แล้ว',
    'ฟังคำแนะนำได้ทุกคน แต่คนลงมือใช้ชีวิตคือเรา เลือกให้ดีแล้วรับผิดชอบให้ไหว',
    'ไม่ต้องเก่งที่สุดในห้อง แค่เก่งกว่าเมื่อวานของตัวเองก็ถือว่ามาถูกทาง',
    'อย่ารอจังหวะที่ใช่จนพลาดทุกจังหวะที่มี',
    'ปัญหาบางอย่างไม่ได้หายไปเพราะเรากังวลเก่งขึ้น ลองลงมือแก้ดูสักข้อ',
    'ความอดทนไม่ใช่การทนทุกอย่าง แต่คือรู้ว่าอะไรควรทำต่อ และอะไรควรวางลง',
    'คนมีฝันต้องมีแผน คนมีแผนต้องลงมือ ส่วนคนมีข้ออ้าง...มีได้ แต่อย่าให้เยอะกว่าแผน',
    'วันที่ทำได้เต็มร้อยก็ดี วันที่ทำได้แค่ครึ่งเดียวแต่ยังไม่ยอมแพ้ก็ดีเหมือนกัน',
    'อย่าดูถูกก้าวเล็ก ๆ เดินไปเรื่อย ๆ เดี๋ยวก็ไกลจนคนขี้เกียจตามไม่ทัน',
    'ความรู้ทำให้เราเริ่มได้ ประสบการณ์ทำให้เรารอบคอบ และอารมณ์ขันช่วยให้เราไม่เครียดกับสองอย่างแรกเกินไป',
    'ไม่มีใครย้อนกลับไปเริ่มต้นใหม่ได้ แต่ทุกคนเริ่มทำให้ตอนจบดีขึ้นได้ตั้งแต่วันนี้'
  ],
  score_summary: ['{displayName} เดือน {month} มีคะแนนสะสม {total} คะแนน'],
  rank_no_data: ['ยังไม่มีคะแนนสำหรับเดือน {month}'],
  rank_header: ['🏆 Top 3 เดือน {month}']
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

async function prepareDailyTop10Announcement(evt) {
  const date = getZonedDateParts();
  if (Number(date.day) % 5 !== 0 || !evt?.replyToken) return;

  const source = evt.source || {};
  const chatId = source.type === 'group' ? source.groupId
    : source.type === 'room' ? source.roomId
      : source.userId || source.senderId || source.memberId || source.user?.id || source.user?.userId;
  if (!chatId) return;

  const dateKey = localDateKey();
  const mk = monthKey();
  const top = await getTop10(mk, 10);
  const { error } = await supabase
    .from('daily_announcements')
    .insert({ chat_id: chatId, date_key: dateKey });
  if (error?.code === '23505') return;
  if (error) throw new Error(error.message || 'Failed to record daily Top 10 announcement');

  const lines = [`📣 อันดับประจำวัน — Top 10 เดือน ${mk}`];
  if (top.length) {
    top.forEach((row) => lines.push(`${row.rank}. ${row.display_name} — ${formatPoints(row.points)} คะแนน`));
  } else {
    lines.push('ยังไม่มีคะแนนในเดือนนี้ มาเริ่มเก็บคะแนนกันเลย!');
  }
  lines.push('', `ดูอันดับแบบเรียลไทม์: ${publicBaseUrl()}/`);
  queueDailyAnnouncement(evt.replyToken, lines.join('\n'));
}

async function prepareDailyCountdownAnnouncement(evt) {
  if (!evt?.replyToken) return;

  const status = await getMonthlyCountdownStatus(monthKey());
  const { error } = await supabase
    .from('daily_announcements')
    .insert({ chat_id: 'global-countdown', date_key: localDateKey() });
  if (error?.code === '23505') return;
  if (error) throw new Error(error.message || 'Failed to record daily countdown announcement');

  queueDailyAnnouncement(
    evt.replyToken,
    `📅 Countdown ภารกิจประจำเดือน\n${formatCountdownStatus(status)}`
  );
}

function queueDailyAnnouncement(replyToken, text) {
  const announcements = dailyAnnouncementsByReplyToken.get(replyToken) || [];
  announcements.push(text);
  dailyAnnouncementsByReplyToken.set(replyToken, announcements);
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
  const detail = parts.slice(1).join(' ').trim();
  const withNote = (description, note = detail) => note ? `${description}: ${note}` : description;
  const userId = evt?.source?.userId
    || evt?.source?.senderId
    || evt?.source?.memberId
    || evt?.source?.user?.id
    || evt?.source?.user?.userId
    || null;
  const sourceType = evt?.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';

  try {
    await prepareDailyCountdownAnnouncement(evt);
  } catch (err) {
    console.error('Daily countdown announcement error:', err?.message || err);
  }

  try {
    await prepareDailyTop10Announcement(evt);
  } catch (err) {
    console.error('Daily Top 10 announcement error:', err?.message || err);
  }

  if (cmd === '/groupid' || cmd === '/group_id') {
    if (sourceType === 'group' && evt.source?.groupId) {
      await reply(evt.replyToken, `Group ID: ${evt.source.groupId}`);
    } else if (sourceType === 'room' && evt.source?.roomId) {
      await reply(evt.replyToken, `Room ID: ${evt.source.roomId}`);
    } else {
      await reply(evt.replyToken, 'คำสั่งนี้ใช้ได้เฉพาะในห้องสนทนากลุ่มหรือ room เท่านั้น');
    }
    return;
  }

  if (!userId) {
    await reply(evt.replyToken, missingUserIdMessage(isGroupOrRoom));
    return;
  }

  const mk = monthKey();
  let displayName = await safeGetDisplayName(userId, evt.source);
  if (!displayName || /\uFFFD/.test(displayName)) displayName = 'คุณ';

  const recordAndReply = async (command, points, message, eventDetail = detail) => {
    await insertEvent({
      user_id: userId,
      display_name: displayName,
      command,
      detail: eventDetail || null,
      points,
      month_key: mk
    });
    await replyWithInspireAndTotal(evt.replyToken, message, displayName, userId, mk, points);
  };

  if (cmd === '/help') {
    const lines = [
      '📚 คำสั่ง 4S:',
      'S1: /ppv <PV> (ส่งรูปตาม), /s1 (ส่งรูปตาม)',
      'S2: /for <จำนวนสาย>, /opp online|onsite, /abo, /m, /s2 (ทุกคำสั่งส่งรูปตาม)',
      'S3: /pin <พิน...>',
      'S4: /link, /book [จำนวนหน้า], /product, /ct, /follow, /hm, /s4 (ส่งรูปตาม)',
      '/score, /rank (Top 3), /rules, /help',
      'คำสั่งแรกของวันจะแจ้ง Countdown ภารกิจรวม และวันที่ 5, 10, 15, 20, 25 หรือ 30 จะแสดง Top 10 ด้วย'
    ];
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  if (cmd === '/rules' || cmd === '/rule') {
    await reply(evt.replyToken, `📘 กติกา 4S to Silver Challenge: ${publicBaseUrl()}/rules`);
    return;
  }

  if (cmd === '/score') {
    const total = await sumUserMonth(userId, mk);
    await reply(evt.replyToken, pickMsg('score_summary', {
      displayName,
      month: mk,
      total: formatPoints(total)
    }));
    return;
  }

  if (cmd === '/rank') {
    const top = await getTop10(mk, 3);
    const countdown = await getMonthlyCountdownStatus(mk);
    if (!top.length) {
      await reply(evt.replyToken, `${pickMsg('rank_no_data', { month: mk })}\n\n${formatCountdownStatus(countdown)}`);
      return;
    }
    const lines = [pickMsg('rank_header', { month: mk }) || `🏆 Top 3 เดือน ${mk}`];
    top.forEach((row) => lines.push(`${row.rank}. ${row.display_name} — ${formatPoints(row.points)} คะแนน`));
    lines.push('', formatCountdownStatus(countdown), '', `ดูอันดับแบบเรียลไทม์: ${publicBaseUrl()}/`);
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  if (cmd === '/ppv') {
    const ppvMatch = detail.match(/^(\d+(?:\.\d{1,2})?)(?:\s+(.+))?$/);
    const pv = Number(ppvMatch?.[1]);
    if (!ppvMatch || !Number.isFinite(pv) || pv <= 0) {
      await reply(evt.replyToken, 'รูปแบบคำสั่งไม่ถูกต้อง กรุณาพิมพ์ /ppv ตามด้วยจำนวน PV แล้วส่งรูปตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, { pv, note: ppvMatch[2] || '' });
    await reply(evt.replyToken, `รับ ${formatNumber(pv)} PV แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึกคะแนน`);
    return;
  }

  if (cmd === '/s1' || cmd === '/s2' || cmd === '/s4') {
    const descriptions = {
      '/s1': 'นำเสนอสินค้า/รายชื่อใหม่',
      '/s2': 'สปอนเซอร์เล่า Business Model',
      '/s4': 'อัปเดตงานและปรึกษาอัปไลน์ผ่านการโทรหรือพบกัน'
    };
    await queueFourSPhoto(userId, cmd, evt, {
      points: 1,
      detail: withNote(descriptions[cmd]),
      description: descriptions[cmd]
    });
    await reply(evt.replyToken, `รับคำสั่ง ${cmd} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +1 คะแนน`);
    return;
  }

  if (cmd === '/for') {
    const callsMatch = detail.match(/^(\d+)(?:\s+(.+))?$/);
    const calls = Number(callsMatch?.[1]);
    if (!callsMatch || !Number.isSafeInteger(calls) || calls <= 0) {
      await reply(evt.replyToken, 'กรุณาพิมพ์จำนวนสายเป็นจำนวนเต็ม เช่น /for 5 แล้วส่งรูปหลักฐานตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, {
      points: calls,
      detail: withNote(`${calls} สายโทรเช็ค FORM`, callsMatch[2] || ''),
      description: `${calls} สายโทรเช็ค FORM`
    });
    await reply(evt.replyToken, `รับ ${calls} สายโทรเช็ค FORM แล้ว กรุณาส่งรูปหลักฐานตาม`);
    return;
  }

  if (cmd === '/opp') {
    const [type, ...noteParts] = parts.slice(1);
    const note = noteParts.join(' ');
    const normalizedType = (type || '').toLowerCase();
    const opportunities = {
      online: { points: 1, description: 'คนใหม่เข้าระบบออนไลน์' },
      onsite: { points: 2, description: 'คนใหม่เข้าระบบเรียนรู้ onsite' }
    };
    const opportunity = opportunities[normalizedType];
    if (!opportunity) {
      await reply(evt.replyToken, 'รูปแบบคำสั่งไม่ถูกต้อง ใช้ /opp online หรือ /opp onsite แล้วส่งรูปตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, {
      points: opportunity.points,
      detail: withNote(opportunity.description, note),
      description: opportunity.description,
      scoreCommand: `/opp ${normalizedType}`
    });
    await reply(evt.replyToken, `รับคำสั่ง /opp ${normalizedType} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +${opportunity.points} คะแนน`);
    return;
  }

  if (cmd === '/abo' || cmd === '/m') {
    const points = cmd === '/abo' ? 5 : 1;
    const description = cmd === '/abo' ? 'คนใหม่สมัครนักธุรกิจ' : 'คนใหม่สมัครสมาชิก';
    await queueFourSPhoto(userId, cmd, evt, {
      points,
      detail: withNote(description),
      description
    });
    await reply(evt.replyToken, `รับคำสั่ง ${cmd.toUpperCase()} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +${points} คะแนน`);
    return;
  }

  if (cmd === '/pin') {
    const pinPoints = new Map([
      ['3%', 1], ['6%', 2], ['9%', 3], ['12%', 4], ['15%', 5], ['18%', 6], ['21%', 7],
      ['elite', 1], ['elite+', 2], ['tp', 2], ['tp+', 4], ['tyong', 1], ['tjoe', 1]
    ]);
    const pinParts = parts.slice(1).map((pin) => pin.replace(/,$/, '').toLowerCase());
    const noteIndex = pinParts.findIndex((pin) => !pinPoints.has(pin));
    const pins = noteIndex === -1 ? pinParts : pinParts.slice(0, noteIndex);
    const note = noteIndex === -1 ? '' : parts.slice(1 + noteIndex).join(' ');
    if (!pins.length) {
      await reply(evt.replyToken, 'ระบุพินที่มูฟเพิ่มหลัง /pin เช่น /pin 3% 6% Elite TP+');
      return;
    }
    const points = pins.reduce((total, pin) => total + pinPoints.get(pin), 0);
    const message = `บันทึกพินที่มูฟเพิ่ม ${pins.map((pin) => `${pin} (+${pinPoints.get(pin)})`).join(', ')} รวม +${formatPoints(points)} คะแนน`;
    await recordAndReply('/pin', points, message, withNote(pins.join(' '), note));
    return;
  }

  const dailyScores = {
    '/link': { points: 0.5, description: 'พัฒนาตัวเองด้วยการส่ง Link' },
    '/product': { points: 0.1, description: 'ใช้สินค้า' },
    '/ct': { points: 1, description: 'เข้าประชุม Center หรือ Beyond และแชร์ After' }
  };
  if (dailyScores[cmd]) {
    const rule = dailyScores[cmd];
    if (cmd !== '/link' && await hasCommandToday(userId, cmd)) {
      await reply(evt.replyToken, `วันนี้บันทึก ${cmd} ไปแล้ว รับคะแนนได้วันละ 1 ครั้ง`);
      return;
    }
    await recordAndReply(
      cmd,
      rule.points,
      `${rule.description} รับ +${formatPoints(rule.points)} คะแนน`,
      withNote(rule.description)
    );
    return;
  }

  if (cmd === '/book') {
    const pageMatch = detail.match(/^(\d+)(?:\s+หน้า)?(?:\s+(.+))?$/);
    const pages = detail ? Number(pageMatch?.[1]) : 10;
    if ((detail && !pageMatch) || !Number.isSafeInteger(pages) || pages < 10) {
      await reply(evt.replyToken, 'อ่านหนังสืออย่างน้อย 10 หน้าต่อวัน แล้วพิมพ์ /book หรือระบุจำนวนหน้า เช่น /book 10 (วันละ 1 ครั้ง)');
      return;
    }
    if (await hasCommandToday(userId, cmd)) {
      await reply(evt.replyToken, 'วันนี้บันทึก /book ไปแล้ว รับคะแนนได้วันละ 1 ครั้ง');
      return;
    }
    const pageCount = detail ? `${pages} หน้า` : 'อย่างน้อย 10 หน้า';
    const pageDetail = withNote(pageCount, pageMatch?.[2] || '');
    await recordAndReply('/book', 0.5, `บันทึกอ่านหนังสือ ${pageCount} รับ +0.5 คะแนน`, pageDetail);
    return;
  }

  if (cmd === '/follow') {
    await recordAndReply(
      '/follow',
      1,
      'บันทึก /follow รับ +1 คะแนน',
      withNote('โทรติดตาม DL/ลูกค้าและอัปเดตในกลุ่มอัปไลน์')
    );
    return;
  }

  if (cmd === '/hm') {
    await recordAndReply(
      '/hm',
      1,
      'บันทึก /hm รับ +1 คะแนน',
      withNote('นัดคนมาเข้าร่วม HM และเล่า HM')
    );
    return;
  }

  await reply(evt.replyToken, `ไม่รู้จักคำสั่ง ${parts[0]} แล้ว ดูคำสั่ง 4S ได้ที่ /rules หรือพิมพ์ /help`);
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

  const pending = await consumeNextFourSPhoto(userId);
  if (!pending) {
    return;
  }

  const mk = pending.month_key || monthKey();
  const imageId = evt?.message?.id || 'image';
  const displayName = await safeGetDisplayName(userId, evt.source);
  const metadata = pending.metadata || {};

  if (metadata.command === '/ppv') {
    const previousPpv = await sumUserMonthPpv(userId, mk);
    const currentPpv = roundTo(previousPpv + Number(metadata.pv), 2);
    const milestones = ppvMilestonesCrossed(previousPpv, currentPpv);
    await insertEvents([
      {
        user_id: userId,
        display_name: displayName,
        command: '/ppv',
        detail: `pv:${metadata.pv}|evidence:${imageId}${metadata.note ? `|note:${metadata.note}` : ''}`,
        points: 0,
        month_key: mk
      },
      ...milestones.map((milestone) => ({
        user_id: userId,
        display_name: displayName,
        command: '/ppv',
        detail: `milestone:${milestone.ppv}pv`,
        points: milestone.points,
        month_key: mk
      }))
    ]);

    const bonusPoints = milestones.reduce((total, milestone) => total + milestone.points, 0);
    const milestoneText = milestones.length
      ? `\n🎉 ถึงเกณฑ์ ${milestones.map((milestone) => `${formatNumber(milestone.ppv)} PV (+${milestone.points})`).join(', ')}`
      : '';
    const message = `บันทึก ${formatNumber(Number(metadata.pv))} PV พร้อมรูปแล้ว\n📊 PV สะสมเดือนนี้: ${formatNumber(currentPpv)} PV${milestoneText}${bonusPoints ? `\nรับเพิ่ม +${formatPoints(bonusPoints)} คะแนน` : ''}`;
    if (bonusPoints) {
      await replyWithInspireAndTotal(evt.replyToken, message, displayName, userId, mk, bonusPoints);
    } else {
      await replyWithInspire(evt.replyToken, message);
    }
    return;
  }
  const command = metadata.scoreCommand || metadata.command;
  const points = Number(metadata.points);
  const eventId = await insertEvent({
    user_id: userId,
    display_name: displayName,
    command,
    detail: [metadata.detail, `evidence:${imageId}`].filter(Boolean).join('|'),
    points,
    month_key: mk
  });
  let message = `${metadata.description || metadata.detail || `บันทึก ${command}`} รับ +${formatPoints(points)} คะแนน`;
  if (['/s1', '/s2', '/opp onsite'].includes(command)) {
    const countdown = await getMonthlyCountdownStatus(mk, eventId, command);
    if (countdown.decremented) {
      const cheer = pick(messagePools.countdown_cheer) || 'อีกหนึ่งก้าวของภารกิจร่วมกัน สำเร็จแล้วครับ';
      message += `\n🎉 ${cheer}\n${formatCountdownStatus(countdown)}`;
    }
  }
  await replyWithInspireAndTotal(evt.replyToken, message, displayName, userId, mk, points);
}

async function top10Handler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const ym = (req.query?.ym || '').toLowerCase();
    const full = (req.query?.full ?? '').toString().toLowerCase();
    const limitRaw = req.query?.limit ?? null;
    const unlimited = full === '1' || full === 'true' || limitRaw === '0' || limitRaw === 'all';
    const limit = unlimited ? 0 : Number(limitRaw || 10);
    const targetMonth = /^\d{4}-\d{2}$/.test(ym) ? ym : monthKey();
    const data = await getTop10(targetMonth, Number.isFinite(limit) ? limit : 10);
    res.json({ meta: { scope: 'month', ym: targetMonth }, data });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load leaderboard' });
  }
}

async function countdownHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const ym = (req.query?.ym || '').toLowerCase();
    const targetMonth = /^\d{4}-\d{2}$/.test(ym) ? ym : monthKey();
    const countdown = await getMonthlyCountdownStatus(targetMonth);
    res.json({ meta: { scope: 'month', ym: targetMonth }, data: countdown });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Failed to load countdown' });
  }
}

module.exports = {
  handleEvent,
  handleImageEvent,
  top10Handler,
  countdownHandler,
  buildWeeklySummaryText,
  push,
  monthsHandler
};
