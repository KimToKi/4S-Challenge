require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const {
  handleEvent,
  handleImageEvent,
  top10Handler,
  countdownHandler,
  buildWeeklySummaryText,
  push,
  monthsHandler
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
app.get('/countdown', countdownHandler);
app.get('/months', monthsHandler);

// Static pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'leaderboard.html')));
app.get('/rules', (req, res) => res.sendFile(path.join(__dirname, 'views', 'rules.html')));

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

  console.log('🔐 Admin endpoint: GET /admin/weekly-push?key=***');
}
