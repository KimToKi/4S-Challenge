const fs = require('fs/promises');
const path = require('path');

const DB_PATH = path.join(__dirname, 'offline-db.json');
const DEFAULT_DB = {
  events: [],
  score_rules: [],
  pending: [],
  sequences: {
    events: 1
  }
};

async function ensureFile() {
  try {
    await fs.access(DB_PATH);
  } catch (err) {
    await fs.writeFile(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

async function loadDb() {
  await ensureFile();
  const raw = await fs.readFile(DB_PATH, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data.events) data.events = [];
    if (!data.score_rules) data.score_rules = [];
    if (!data.pending) data.pending = [];
    if (!data.sequences) data.sequences = { events: 1 };
    if (typeof data.sequences.events !== 'number' || !Number.isFinite(data.sequences.events)) {
      data.sequences.events = 1;
    }
    return data;
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

async function saveDb(db) {
  const clone = JSON.parse(JSON.stringify(db));
  await fs.writeFile(DB_PATH, JSON.stringify(clone, null, 2));
}

function clone(row) {
  return JSON.parse(JSON.stringify(row));
}

function norm(value) {
  return String(value ?? '').trim().toLowerCase();
}

function ensureTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString();
  }
  return d.toISOString();
}

async function listEvents() {
  const db = await loadDb();
  return db.events.map(clone);
}

async function listEventsWithFilter(predicate) {
  const db = await loadDb();
  return db.events.filter(predicate).map(clone);
}

async function getScoreRule(command, subtype) {
  const db = await loadDb();
  const cmd = norm(command);
  const sub = norm(subtype);
  const rule = db.score_rules.find((row) => norm(row.command) === cmd && norm(row.subtype) === sub);
  return rule ? clone(rule) : null;
}

async function upsertScoreRules(rows) {
  if (!Array.isArray(rows)) return;
  const db = await loadDb();
  for (const row of rows) {
    const cmd = norm(row.command);
    const sub = norm(row.subtype);
    const idx = db.score_rules.findIndex((r) => norm(r.command) === cmd && norm(r.subtype) === sub);
    if (idx >= 0) {
      db.score_rules[idx] = { ...db.score_rules[idx], ...row };
    } else {
      db.score_rules.push({ command: row.command, subtype: row.subtype ?? '', points: row.points ?? 0 });
    }
  }
  await saveDb(db);
}

async function countEventsByUserCommandMonth(userId, command, monthKey) {
  const cmd = norm(command);
  const db = await loadDb();
  return db.events.filter((ev) => ev.user_id === userId && norm(ev.command) === cmd && ev.month_key === monthKey).length;
}

async function getRecentEvents({ userId, command, monthKey, limit = 20 }) {
  const cmd = norm(command);
  const db = await loadDb();
  const rows = db.events
    .filter((ev) => ev.user_id === userId && norm(ev.command) === cmd && ev.month_key === monthKey)
    .map(clone)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return rows.slice(0, limit);
}

async function upsertPending(entry, conflictKeys = []) {
  if (!entry) return;
  const db = await loadDb();
  const keyValues = conflictKeys.map((k) => entry[k]);
  const idx = db.pending.findIndex((row) => conflictKeys.every((k, i) => row[k] === keyValues[i]));
  if (idx >= 0) {
    db.pending[idx] = { ...db.pending[idx], ...entry };
  } else {
    db.pending.push({ ...entry });
  }
  await saveDb(db);
}

async function findPending(entryKeys) {
  const db = await loadDb();
  return clone(db.pending.find((row) => Object.entries(entryKeys).every(([k, v]) => row[k] === v)) || null);
}

async function deletePending(entryKeys) {
  const db = await loadDb();
  const original = db.pending.length;
  db.pending = db.pending.filter((row) => !Object.entries(entryKeys).every(([k, v]) => row[k] === v));
  if (db.pending.length !== original) {
    await saveDb(db);
  } else if (original === 0) {
    await saveDb(db);
  }
}

async function insertEvent(event) {
  const db = await loadDb();
  const id = Number(db.sequences.events) || 1;
  db.sequences.events = id + 1;
  const row = {
    id,
    user_id: event.user_id,
    display_name: event.display_name || '',
    command: event.command,
    detail: event.detail || '',
    points: event.points || 0,
    month_key: event.month_key || null,
    timestamp: ensureTimestamp(event.timestamp)
  };
  db.events.push(row);
  await saveDb(db);
  return clone(row);
}

async function sumPointsByUserMonth(userId, monthKey) {
  const db = await loadDb();
  return db.events
    .filter((ev) => ev.user_id === userId && ev.month_key === monthKey)
    .reduce((sum, ev) => sum + Number(ev.points || 0), 0);
}

async function listEventsForMonth(monthKey) {
  const db = await loadDb();
  return db.events.filter((ev) => ev.month_key === monthKey).map(clone);
}

async function listAllEvents() {
  return listEvents();
}

async function listDistinctMonthKeys() {
  const db = await loadDb();
  const set = new Set();
  for (const ev of db.events) {
    if (ev.month_key) set.add(ev.month_key);
  }
  return Array.from(set);
}

async function listEventsBetween(startUtc, endUtc) {
  const start = startUtc ? new Date(startUtc) : null;
  const end = endUtc ? new Date(endUtc) : null;
  const db = await loadDb();
  return db.events.filter((ev) => {
    const t = new Date(ev.timestamp || 0);
    if (Number.isNaN(t.getTime())) return false;
    if (start && t < start) return false;
    if (end && t >= end) return false;
    return true;
  }).map(clone);
}

async function listEventsWithNonNullTimestamp() {
  const db = await loadDb();
  return db.events.filter((ev) => ev.timestamp).map(clone);
}

async function getLink30dUsers(monthKey) {
  const db = await loadDb();
  return db.events
    .filter((ev) => ev.month_key === monthKey && norm(ev.command) === norm('/link_30d'))
    .map(clone);
}

async function countDistinctDays(userId, command, monthKey, toDateKey) {
  const db = await loadDb();
  const cmd = norm(command);
  const set = new Set();
  for (const ev of db.events) {
    if (ev.user_id !== userId) continue;
    if (norm(ev.command) !== cmd) continue;
    if (ev.month_key !== monthKey) continue;
    const key = toDateKey(new Date(ev.timestamp || 0));
    if (key) set.add(key);
  }
  return set.size;
}

async function listUsersForMonth(monthKey) {
  const db = await loadDb();
  return db.events
    .filter((ev) => ev.month_key === monthKey)
    .map((ev) => ({ user_id: ev.user_id, display_name: ev.display_name }));
}

async function countCommandOccurrences(userId, command, monthKey) {
  return countEventsByUserCommandMonth(userId, command, monthKey);
}

async function updateEventMonthKey(id, monthKey) {
  const db = await loadDb();
  const ev = db.events.find((row) => row.id === id);
  if (!ev) return false;
  ev.month_key = monthKey;
  await saveDb(db);
  return true;
}

module.exports = {
  ensureFile,
  loadDb,
  saveDb,
  listEvents,
  listEventsWithFilter,
  getScoreRule,
  upsertScoreRules,
  countEventsByUserCommandMonth,
  getRecentEvents,
  upsertPending,
  findPending,
  deletePending,
  insertEvent,
  sumPointsByUserMonth,
  listEventsForMonth,
  listAllEvents,
  listDistinctMonthKeys,
  listEventsBetween,
  listEventsWithNonNullTimestamp,
  getLink30dUsers,
  countDistinctDays,
  listUsersForMonth,
  countCommandOccurrences,
  updateEventMonthKey
};
