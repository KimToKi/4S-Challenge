function parseField(field, min, max) {
  if (field === '*') return null;
  const value = Number(field);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid cron field '${field}'`);
  }
  return new Set([value]);
}

function parseExpression(expr) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression '${expr}'`);
  }
  const [min, hour, day, month, dow] = parts;
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hour, 0, 23),
    day: parseField(day, 1, 31),
    month: parseField(month, 1, 12),
    dow: parseField(dow, 0, 6)
  };
}

const WEEKDAY_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

function getDateParts(date, timezone) {
  if (!timezone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
      year: date.getFullYear()
    };
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
    year: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const weekday = (map.weekday || 'sun').toLowerCase().slice(0, 3);
  return {
    minute: Number(map.minute),
    hour: Number(map.hour),
    day: Number(map.day),
    month: Number(map.month),
    dow: WEEKDAY_INDEX[weekday] ?? 0,
    year: Number(map.year)
  };
}

function matches(cron, parts) {
  if (cron.minute && !cron.minute.has(parts.minute)) return false;
  if (cron.hour && !cron.hour.has(parts.hour)) return false;
  if (cron.day && !cron.day.has(parts.day)) return false;
  if (cron.month && !cron.month.has(parts.month)) return false;
  if (cron.dow && !cron.dow.has(parts.dow)) return false;
  return true;
}

function schedule(expr, handler, options = {}) {
  if (typeof handler !== 'function') {
    throw new Error('Cron handler must be a function');
  }
  const cron = parseExpression(expr);
  const timezone = options.timezone;
  let lastKey = null;

  const check = async () => {
    const now = new Date();
    const parts = getDateParts(now, timezone);
    const key = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`;
    if (key === lastKey) return;
    if (matches(cron, parts)) {
      lastKey = key;
      try {
        await handler();
      } catch (err) {
        console.error('Cron handler error:', err?.message || err);
      }
    }
  };

  const timer = setInterval(check, 30000);
  check().catch(() => {});

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

module.exports = { schedule };
