const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFireStatuses,
  getFireStatusesByDate,
  selectRankDisplayRows
} = require('../fire-status');

const today = '2026-11-22';
const currentMonth = today.slice(0, 7);
const event = (user_id, command, timestamp = `${today}T12:00:00Z`, detail = '', points = 1) => ({
  user_id,
  command,
  timestamp,
  detail,
  points
});
const getDateKey = (date) => date.toISOString().slice(0, 10);

test('rank display adds all rank-fire users and places them before higher-ranked users without fire', () => {
  const ranking = [
    { user_id: 'user-1', rank: 1 },
    { user_id: 'user-2', rank: 2 },
    { user_id: 'user-3', rank: 3 },
    { user_id: 'user-4', rank: 4 }
  ];
  const fires = new Map([
    ['user-2', { rank: true }],
    ['user-4', { rank: true }]
  ]);

  assert.deepEqual(
    selectRankDisplayRows(ranking, fires, 3).map(({ user_id, rank, rankFire }) => ({
      user_id,
      rank,
      rankFire
    })),
    [
      { user_id: 'user-2', rank: 2, rankFire: true },
      { user_id: 'user-4', rank: 4, rankFire: true },
      { user_id: 'user-1', rank: 1, rankFire: false },
      { user_id: 'user-3', rank: 3, rankFire: false }
    ]
  );
});

test('lights category fires and the rank fire when all four are active', () => {
  const statuses = getFireStatuses([
    event('user-1', '/ppv', undefined, 'pv:600'),
    event('user-1', '/opp online'),
    event('user-1', '/pin', '2026-11-02T10:00:00Z'),
    event('user-1', '/book')
  ], { today, currentMonth, getDateKey });

  assert.deepEqual(statuses.get('user-1'), {
    s1: true,
    s2: true,
    s3: true,
    s4: true,
    rank: true
  });
});

test('S1 command lights S1 and S3 achievement keeps its fire for the whole month', () => {
  const statuses = getFireStatuses([
    event('user-1', '/s1'),
    event('user-1', '/s2'),
    event('user-1', '/pin', '2026-11-02T10:00:00Z'),
    event('user-1', '/s4')
  ], { today, currentMonth, getDateKey });

  assert.equal(statuses.get('user-1').s1, true);
  assert.equal(statuses.get('user-1').s3, true);
  assert.equal(statuses.get('user-1').rank, true);
});

test('does not light rank when PPV has not increased or an S category is missing', () => {
  const statuses = getFireStatuses([
    event('user-1', '/ppv', undefined, 'pv:0'),
    event('user-1', '/opp onsite'),
    event('user-1', '/pin'),
    event('user-1', '/book')
  ], { today, currentMonth, getDateKey });

  assert.deepEqual(statuses.get('user-1'), {
    s1: false,
    s2: true,
    s3: true,
    s4: true,
    rank: false
  });
});

test('S3 fire requires a successful pin achievement in the current month', () => {
  const statuses = getFireStatuses([
    event('user-1', '/s1'),
    event('user-1', '/s2'),
    event('user-1', '/pin', '2026-10-31T12:00:00Z'),
    event('user-1', '/s4')
  ], { today, currentMonth, getDateKey });

  assert.equal(statuses.get('user-1').s3, false);
  assert.equal(statuses.get('user-1').rank, false);
});

test('S1, S2, and S4 fires do not carry over from the previous day', () => {
  const statuses = getFireStatuses([
    event('user-1', '/s1', '2026-11-21T12:00:00Z'),
    event('user-1', '/s2', '2026-11-21T12:00:00Z'),
    event('user-1', '/pin', '2026-11-02T10:00:00Z'),
    event('user-1', '/s4', '2026-11-21T12:00:00Z')
  ], { today, currentMonth, getDateKey });

  assert.deepEqual(statuses.get('user-1'), {
    s1: false,
    s2: false,
    s3: true,
    s4: false,
    rank: false
  });
});

test('historical mission fire requires all daily categories and a pin achieved by that date', () => {
  const history = getFireStatusesByDate([
    event('user-1', '/s1', '2026-11-21T12:00:00Z'),
    event('user-1', '/s2', '2026-11-21T12:00:00Z'),
    event('user-1', '/s4', '2026-11-21T12:00:00Z'),
    event('user-1', '/pin', '2026-11-22T10:00:00Z'),
    event('user-1', '/s1', '2026-11-22T12:00:00Z'),
    event('user-1', '/s2', '2026-11-22T12:00:00Z'),
    event('user-1', '/s4', '2026-11-22T12:00:00Z')
  ], { getDateKey });

  assert.equal(history.get('2026-11-21').get('user-1').rank, false);
  assert.equal(history.get('2026-11-22').get('user-1').rank, true);
});
