const s2Commands = new Set([
  '/for', '/opp', '/opp online', '/opp onsite', '/abo', '/m', '/s2'
]);
const s4Commands = new Set([
  '/link', '/book', '/product', '/ct', '/follow', '/hm', '/s4', '/dm'
]);

function isPpvIncrease(event) {
  const match = String(event.detail || '').match(/^pv:(\d+(?:\.\d+)?)(?:\||$)/i);
  return match !== null && Number(match[1]) > 0;
}

function getFireStatuses(events, { today, currentMonth, getDateKey }) {
  const users = new Map();

  for (const event of events) {
    if (!event.user_id || !event.timestamp) continue;

    const date = getDateKey(new Date(event.timestamp));
    if (!date) continue;
    const month = date.slice(0, 7);
    const command = String(event.command || '').trim().toLowerCase();
    const user = users.get(event.user_id) || {
      activeToday: new Set(),
      achievementMonths: new Set()
    };

    if (command === '/pin' && Number(event.points || 0) > 0) {
      user.achievementMonths.add(month);
    }

    if (date === today) {
      if (command === '/s1' || (command === '/ppv' && isPpvIncrease(event))) {
        user.activeToday.add('s1');
      }
      if (s2Commands.has(command)) user.activeToday.add('s2');
      if (s4Commands.has(command)) user.activeToday.add('s4');
    }

    users.set(event.user_id, user);
  }

  return new Map(Array.from(users, ([userId, user]) => {
    const fires = {
      s1: user.activeToday.has('s1'),
      s2: user.activeToday.has('s2'),
      s3: user.achievementMonths.has(currentMonth),
      s4: user.activeToday.has('s4')
    };
    fires.rank = fires.s1 && fires.s2 && fires.s3 && fires.s4;
    return [userId, fires];
  }));
}

function getFireStatusesByDate(events, { getDateKey }) {
  const usersByDate = new Map();
  const firstAchievementByUserMonth = new Map();

  for (const event of events) {
    if (!event.user_id || !event.timestamp) continue;

    const date = getDateKey(new Date(event.timestamp));
    if (!date) continue;
    const month = date.slice(0, 7);
    const command = String(event.command || '').trim().toLowerCase();

    if (command === '/pin' && Number(event.points || 0) > 0) {
      const monthByUser = firstAchievementByUserMonth.get(event.user_id) || new Map();
      const firstAchievement = monthByUser.get(month);
      if (!firstAchievement || date < firstAchievement) monthByUser.set(month, date);
      firstAchievementByUserMonth.set(event.user_id, monthByUser);
    }

    const dateByUser = usersByDate.get(date) || new Map();
    const user = dateByUser.get(event.user_id) || new Set();
    if (command === '/s1' || (command === '/ppv' && isPpvIncrease(event))) user.add('s1');
    if (s2Commands.has(command)) user.add('s2');
    if (s4Commands.has(command)) user.add('s4');
    dateByUser.set(event.user_id, user);
    usersByDate.set(date, dateByUser);
  }

  return new Map(Array.from(usersByDate, ([date, dateByUser]) => {
    const statuses = new Map(Array.from(dateByUser, ([userId, active]) => {
      const firstAchievement = firstAchievementByUserMonth.get(userId)?.get(date.slice(0, 7));
      const fires = {
        s1: active.has('s1'),
        s2: active.has('s2'),
        s3: Boolean(firstAchievement && firstAchievement <= date),
        s4: active.has('s4')
      };
      fires.rank = fires.s1 && fires.s2 && fires.s3 && fires.s4;
      return [userId, fires];
    }));
    return [date, statuses];
  }));
}

module.exports = { getFireStatuses, getFireStatusesByDate };
