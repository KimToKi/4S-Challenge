require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const cron = require('node-cron');
const {
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
} = require('./logic');

const PORT = process.env.PORT || 3000;
const app = express();

// Do NOT use a global JSON parser. Nothing else here needs it.
app.use('/static', express.static(path.join(__dirname, 'views')));

// LINE Webhook endpoint
// Use raw body so verification/empty payloads never cause 400
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  // Always ACK immediately to avoid upstream timeouts
  res.status(200).send('OK');

  let payload = {};
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    payload = raw ? JSON.parse(raw) : {};
  } catch (_) {
    payload = {};
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) {
    console.warn('Webhook received non-standard payload');
    return;
  }

  try {
    for (const ev of events) {
      if (ev.type === 'message') {
        if (ev.message?.type === 'text') {
          await handleEvent(ev);
        } else if (ev.message?.type === 'image') {
          await handleImageEvent(ev);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err?.message);
  }
});

// Optional: respond to GET on /webhook so manual checks don't fail
app.get('/webhook', (req, res) => res.status(200).send('OK'));

// Leaderboard endpoints
app.get('/top10', top10Handler);
app.get('/months', monthsHandler);
app.get('/weeks', weeksHandler);

// Static pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'leaderboard.html')));
app.get('/rules', (req, res) => res.sendFile(path.join(__dirname, 'views', 'rules.html')));
app.get('/rules-image.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'rulesdn.png'));
});

// Helper: format /link_30d monthly announcement with emojis
function buildLink30dAnnouncement(monthKey, settled) {
  const bonuses = settled.filter(r => Number(r.points) > 0);
  const lines = [`🗓️ สรุปคะแนน /link_30d ประจำเดือน ${monthKey}`];
  if (bonuses.length) {
    lines.push('✅ โบนัสครบ 30 วัน (+1):');
    bonuses.forEach(r => lines.push(`• ✨ ${r.display_name} +${Number(r.points)}`));
  } else {
    lines.push('ℹ️ เดือนนี้ยังไม่มีใครทำครบทุกวัน');
  }
  return lines;
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Weekly push via cron
const weeklyCron = process.env.WEEKLY_CRON || '0 9 * * 1';
const weeklyTz = process.env.WEEKLY_TZ || 'Asia/Bangkok';
try {
  cron.schedule(weeklyCron, async () => {
    try {
      const text = await buildWeeklySummaryText();
      await push(text);
      console.log('✅ Weekly leaderboard pushed');
    } catch (err) {
      console.error('Weekly push error:', err?.message);
    }
  }, { timezone: weeklyTz });
  console.log(`🕒 Weekly push scheduled: '${weeklyCron}' TZ ${weeklyTz}`);
} catch (err) {
  console.warn('Weekly cron invalid or failed to start:', err?.message);
}

// Admin endpoints (optional)
if (process.env.ADMIN_KEY) {
  app.get('/admin/weekly-push', async (req, res) => {
    if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
    try {
      const text = await buildWeeklySummaryText();
      await push(text);
      res.status(200).send('Pushed');
    } catch (e) {
      res.status(500).send('Error');
    }
  });

  app.get('/admin/link30d-settle', async (req, res) => {
    if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
    try {
      const ym = (req.query.ym || '').match(/^\d{4}-\d{2}$/) ? req.query.ym : new Date().toISOString().slice(0,7);
      const result = await finalizeLink30dMonth(ym);
      if ((req.query.push || '').toLowerCase() === 'true' || req.query.push === '1') {
        const lines = buildLink30dAnnouncement(ym, result.settled);
        if (lines.length > 1) await push(lines.join('\n'));
      }
      res.json(result);
    } catch (e) {
      res.status(500).send('Error');
    }
  });

  app.get('/admin/book-settle', async (req, res) => {
    if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
    try {
      const ym = (req.query.ym || '').match(/^\d{4}-\d{2}$/) ? req.query.ym : new Date().toISOString().slice(0,7);
      const result = await finalizeBookMonth(ym);
      res.json(result);
    } catch (e) {
      res.status(500).send('Error');
    }
  });

  console.log('🔐 Admin endpoint: GET /admin/weekly-push?key=***');
  console.log('🔐 Admin endpoint: GET /admin/link30d-settle?key=***&ym=YYYY-MM&push=1');
  console.log('🔐 Admin endpoint: GET /admin/book-settle?key=***&ym=YYYY-MM (apply /book bonus)');
}

// Monthly settlement via cron (last day of month, 23:55 local time)
const monthlyCron = process.env.MONTHLY_CRON || '55 23 * * *';
const monthlyTz = process.env.MONTHLY_TZ || 'Asia/Bangkok';
try {
  cron.schedule(monthlyCron, async () => {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const isMonthEnd = tomorrow.getMonth() !== now.getMonth();
      if (!isMonthEnd) return;
      const mk = now.toISOString().slice(0,7);
      const result = await finalizeLink30dMonth(mk);
      try {
        const book = await finalizeBookMonth(mk);
        if (book?.settled?.length) {
          console.log(`📚 Monthly book bonus awarded to ${book.settled.length} member(s)`);
        }
      } catch (err) {
        console.error('Monthly book bonus error:', err?.message);
      }
      try {
        await finalizePlanUpdateMonth(mk); // /plan_update ให้คะแนนทันที ฟังก์ชันนี้คงไว้เพื่อความเข้ากันได้
      } catch (err) {
        console.error('Monthly plan_update settle error:', err?.message);
      }
      const lines = buildLink30dAnnouncement(mk, result.settled);
      if (lines.length > 1) await push(lines.join('\n'));
      console.log(`📅 Monthly link_30d settled for ${mk}`);
    } catch (err) {
      console.error('Monthly settle error:', err?.message);
    }
  }, { timezone: monthlyTz });
  console.log(`🕒 Monthly settle scheduled: '${monthlyCron}' TZ ${monthlyTz} (last day only)`);
} catch (err) {
  console.warn('Monthly cron invalid or failed to start:', err?.message);
}
