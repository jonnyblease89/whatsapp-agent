const functions  = require('@google-cloud/functions-framework');
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { handleMessage }    = require('./handler');
const { sendDailySummary } = require('./summary');
const { saveSubscription } = require('./push');
const { getConversations, getConversation, setStatus, setResolved, appendIanMessage } = require('./store');
const { sendMessage }                                         = require('./twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function auth(req, res, next) {
  if (req.headers['x-inbox-token'] !== process.env.INBOX_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Inbox web app
app.use('/inbox', express.static(path.join(__dirname, 'web')));

// Twilio inbound webhook
app.post('/', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  const to   = req.body.To;
  if (!from || !body) return res.status(400).send('Bad request');
  try { await handleMessage(from, body, to); } catch (e) { console.error(e); }
  res.status(200).send('OK');
});

// Inbox: list conversations
app.get('/conversations', auth, async (req, res) => {
  const conversations = await getConversations();
  res.json(conversations);
});

// Inbox: single conversation
app.get('/conversations/:phone', auth, async (req, res) => {
  const conv = await getConversation(decodeURIComponent(req.params.phone));
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Inbox: Ian sends a reply
app.post('/reply', auth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  const conv = await getConversation(phone);
  const twilioFrom = conv?.twilioNumber || `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
  await sendMessage(twilioFrom, `whatsapp:${phone}`, message);
  await appendIanMessage(phone, message);
  res.json({ ok: true });
});

// Daily summary (called by Cloud Scheduler)
app.post('/daily-summary', auth, async (req, res) => {
  try { await sendDailySummary(); } catch (e) { console.error(e); }
  res.json({ ok: true });
});

// Inbox summary card
app.get('/inbox-summary', auth, async (req, res) => {
  try {
    const { getInboxSummary } = require('./summary');
    const summary = await getInboxSummary();
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.json({ summary: null });
  }
});

// Push subscription
app.post('/subscribe', auth, async (req, res) => {
  await saveSubscription(req.body);
  res.json({ ok: true });
});

// VAPID public key for client
app.get('/vapid-public-key', auth, (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// Inbox: Ian takes over
app.post('/takeover', auth, async (req, res) => {
  await setStatus(req.body.phone, 'human');
  res.json({ ok: true });
});

// Inbox: Hand back to bot
app.post('/handback', auth, async (req, res) => {
  await setStatus(req.body.phone, 'bot');
  res.json({ ok: true });
});

// Inbox: Resolve / reopen conversation
app.post('/resolve', auth, async (req, res) => {
  const { phone, resolved } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  await setResolved(phone, !!resolved);
  res.json({ ok: true });
});

functions.http('whatsappWebhook', app);
