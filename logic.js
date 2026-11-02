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

function composeInspireText(text, displayName) {
  const quote = pick(messagePools.inspire) || '';
  if (!quote) return text;
  const name = displayName ? `✨ ${displayName}` : '✨';
  return `${text}\n${name} ${quote}`;
}

async function replyWithInspire(replyToken, text, displayName) {
  await reply(replyToken, composeInspireText(text, displayName));
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
  await replyWithInspire(replyToken, lines.filter(Boolean).join('\n'), displayName);
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

function isLastDayOfMonth(date = new Date()) {
  const parts = getZonedDateParts(date);
  const lastDay = new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate();
  return Number(parts.day) === lastDay;
}

async function getTop10(mk, limit = 10) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, points, timestamp')
    .eq('month_key', mk);
  if (error) throw new Error(error.message || 'Failed to fetch events');
  return rankAndLimit(aggregateEventsByUser(data), limit)
    .map((r) => ({ ...r, points: roundTo(r.points, 2) }));
}

async function getMonthRanking(mk) {
  await dbReady;
  const { data, error } = await supabase
    .from('events')
    .select('user_id, display_name, points, timestamp')
    .eq('month_key', mk);
  if (error) throw new Error(error.message || 'Failed to load month ranking');
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
  inspire: [
    'วันนี้ทำได้ดีมากเลยนะ',
    'เติมพลังไว้ แล้วไปต่อกัน',
    'ก้าวเล็กๆ วันนี้ คือชัยชนะของพรุ่งนี้',
    'ทีมเราเชื่อในตัวคุณนะ ✨',
    'อัพไลน์เชื่อในตัวคุณนะ ✨',
    'พักหายใจนิดนึง แล้วลุยต่อ'
  ],
  score_summary: ['{displayName} เดือน {month} มีคะแนนสะสม {total} คะแนน'],
  rank_no_data: ['ยังไม่มีคะแนนสำหรับเดือน {month}'],
  rank_header: ['🏆 Top 10 เดือน {month}']
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
  const detail = parts.slice(1).join(' ').trim();
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
      'S3: /pin <พิน...> (ใช้ได้วันสุดท้ายของเดือน)',
      'S4: /link, /book [จำนวนหน้า], /product, /ct, /follow, /hm HM1|HM2|HM3|HM4, /s4 (ส่งรูปตาม)',
      '/score, /rank, /rules, /help'
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
    const top = await getTop10(mk, 10);
    if (!top.length) {
      await reply(evt.replyToken, pickMsg('rank_no_data', { month: mk }));
      return;
    }
    const lines = [pickMsg('rank_header', { month: mk }) || `🏆 Top 10 เดือน ${mk}`];
    top.forEach((row) => lines.push(`${row.rank}. ${row.display_name} — ${formatPoints(row.points)} คะแนน`));
    lines.push('', `ดู Top 10 แบบเรียลไทม์: ${publicBaseUrl()}/`);
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  if (cmd === '/ppv') {
    const pv = Number(detail);
    if (!/^\d+(?:\.\d{1,2})?$/.test(detail) || !Number.isFinite(pv) || pv <= 0) {
      await reply(evt.replyToken, 'รูปแบบคำสั่งไม่ถูกต้อง กรุณาพิมพ์ /ppv ตามด้วยจำนวน PV แล้วส่งรูปตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, { pv });
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
      detail: detail || descriptions[cmd],
      description: descriptions[cmd]
    });
    await reply(evt.replyToken, `รับคำสั่ง ${cmd} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +1 คะแนน`);
    return;
  }

  if (cmd === '/for') {
    const calls = Number(detail);
    if (!/^\d+$/.test(detail) || !Number.isSafeInteger(calls) || calls <= 0) {
      await reply(evt.replyToken, 'กรุณาพิมพ์จำนวนสายเป็นจำนวนเต็ม เช่น /for 5 แล้วส่งรูปหลักฐานตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, {
      points: calls,
      detail: `${calls} สายโทรเช็ค FORM`
    });
    await reply(evt.replyToken, `รับ ${calls} สายโทรเช็ค FORM แล้ว กรุณาส่งรูปหลักฐานตาม`);
    return;
  }

  if (cmd === '/opp') {
    const type = detail.toLowerCase();
    const opportunities = {
      online: { points: 1, description: 'คนใหม่เข้าระบบออนไลน์' },
      onsite: { points: 2, description: 'คนใหม่เข้าระบบเรียนรู้ onsite' }
    };
    const opportunity = opportunities[type];
    if (!opportunity || parts.length !== 2) {
      await reply(evt.replyToken, 'รูปแบบคำสั่งไม่ถูกต้อง ใช้ /opp online หรือ /opp onsite แล้วส่งรูปตาม');
      return;
    }
    await queueFourSPhoto(userId, cmd, evt, {
      points: opportunity.points,
      detail: opportunity.description,
      scoreCommand: `/opp ${type}`
    });
    await reply(evt.replyToken, `รับคำสั่ง /opp ${type} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +${opportunity.points} คะแนน`);
    return;
  }

  if (cmd === '/abo' || cmd === '/m') {
    const points = cmd === '/abo' ? 5 : 1;
    const description = cmd === '/abo' ? 'คนใหม่สมัครนักธุรกิจ' : 'คนใหม่สมัครสมาชิก';
    await queueFourSPhoto(userId, cmd, evt, { points, detail: description });
    await reply(evt.replyToken, `รับคำสั่ง ${cmd.toUpperCase()} แล้ว กรุณาส่งรูปหลักฐานตามเพื่อบันทึก +${points} คะแนน`);
    return;
  }

  if (cmd === '/pin') {
    if (!isLastDayOfMonth()) {
      await reply(evt.replyToken, 'คำสั่ง /pin ใช้ได้เฉพาะวันสุดท้ายของเดือนเท่านั้น');
      return;
    }
    const pinPoints = new Map([
      ['3%', 1], ['6%', 2], ['9%', 3], ['12%', 4], ['15%', 5], ['18%', 6], ['21%', 7],
      ['elite', 1], ['elite+', 2], ['tp', 2], ['tp+', 4], ['tyong', 1], ['tjoe', 1]
    ]);
    const pins = parts.slice(1).map((pin) => pin.replace(/,$/, '').toLowerCase());
    if (!pins.length || pins.some((pin) => !pinPoints.has(pin))) {
      await reply(evt.replyToken, 'ระบุพินที่มูฟเพิ่มหลัง /pin เช่น /pin 3% 6% Elite TP+');
      return;
    }
    const points = pins.reduce((total, pin) => total + pinPoints.get(pin), 0);
    const message = `บันทึกพินที่มูฟเพิ่ม ${pins.map((pin) => `${pin} (+${pinPoints.get(pin)})`).join(', ')} รวม +${formatPoints(points)} คะแนน`;
    await recordAndReply('/pin', points, message, pins.join(' '));
    return;
  }

  const dailyScores = {
    '/link': { points: 0.5, description: 'พัฒนาตัวเองด้วยการส่ง Link' },
    '/product': { points: 0.1, description: 'ใช้สินค้า' },
    '/ct': { points: 1, description: 'เข้าประชุม Center หรือ Beyond และแชร์ After' }
  };
  if (dailyScores[cmd]) {
    const rule = dailyScores[cmd];
    if (await hasCommandToday(userId, cmd)) {
      await reply(evt.replyToken, `วันนี้บันทึก ${cmd} ไปแล้ว รับคะแนนได้วันละ 1 ครั้ง`);
      return;
    }
    await recordAndReply(cmd, rule.points, `${rule.description} รับ +${formatPoints(rule.points)} คะแนน`);
    return;
  }

  if (cmd === '/book') {
    const pages = detail ? Number(detail) : 10;
    if ((detail && !/^\d+$/.test(detail)) || !Number.isSafeInteger(pages) || pages < 10) {
      await reply(evt.replyToken, 'อ่านหนังสืออย่างน้อย 10 หน้าต่อวัน แล้วพิมพ์ /book หรือระบุจำนวนหน้า เช่น /book 10 (วันละ 1 ครั้ง)');
      return;
    }
    if (await hasCommandToday(userId, cmd)) {
      await reply(evt.replyToken, 'วันนี้บันทึก /book ไปแล้ว รับคะแนนได้วันละ 1 ครั้ง');
      return;
    }
    const pageDetail = detail ? `${pages} หน้า` : 'อย่างน้อย 10 หน้า';
    await recordAndReply('/book', 0.5, `บันทึกอ่านหนังสือ ${pageDetail} รับ +0.5 คะแนน`, pageDetail);
    return;
  }

  if (cmd === '/follow') {
    await recordAndReply('/follow', 1, 'บันทึกการโทรติดตาม DL/ลูกค้าและอัปเดตในกลุ่มอัปไลน์ รับ +1 คะแนน');
    return;
  }

  if (cmd === '/hm') {
    const hm = (parts[1] || '').toUpperCase();
    if (parts.length !== 2 || !/^HM[1-4]$/.test(hm)) {
      await reply(evt.replyToken, 'ระบุหัวข้อที่เล่า เช่น /hm HM1 (เลือก HM1–HM4)');
      return;
    }
    await recordAndReply('/hm', 1, `บันทึกการเล่า ${hm} ผู้เล่าได้รับ +1 คะแนน`, hm);
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
    await reply(evt.replyToken, 'ไม่พบคำสั่ง 4S ที่รอรูป กรุณาพิมพ์คำสั่งก่อนส่งรูป');
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
        detail: `pv:${metadata.pv}|evidence:${imageId}`,
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
      await replyWithInspire(evt.replyToken, message, displayName);
    }
    return;
  }

  const command = metadata.scoreCommand || metadata.command;
  const points = Number(metadata.points);
  await insertEvent({
    user_id: userId,
    display_name: displayName,
    command,
    detail: [metadata.detail, `evidence:${imageId}`].filter(Boolean).join('|'),
    points,
    month_key: mk
  });
  const message = `${metadata.description || metadata.detail || `บันทึก ${command}`} รับ +${formatPoints(points)} คะแนน`;
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

module.exports = {
  handleEvent,
  handleImageEvent,
  top10Handler,
  buildWeeklySummaryText,
  push,
  monthsHandler
};
