const functions  = require('@google-cloud/functions-framework');
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');
const { handleMessage, buildSystemPrompt, getBusinessHoursStatus } = require('./handler');
const { lookupCustomer } = require('./sheets');
const { sendDailySummary } = require('./summary');
const { saveSubscription } = require('./push');
const { askClaude }        = require('./claude');
const { getConversations, getConversation, setStatus, setResolved, appendIanMessage, markRead, getGarageConfig, setGarageConfig, getUsage } = require('./store');
const { sendMessage }                                         = require('./twilio');
const { verifyTwilioSignature }                                = require('./security');
const { isRateLimited }                                        = require('./rateLimit');
const { buildBillingSummary, previousMonth, formatBillingEmail } = require('./billing');
const { sendEmail }                                            = require('./email');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function auth(req, res, next) {
  const provided = req.headers['x-inbox-token'] || '';
  const expected = process.env.INBOX_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Separate, lower-value token for the staging chat — deliberately not INBOX_SECRET, so a
// token baked into test-web/app.js (no login screen) can't be used to read real customer
// conversations or send messages as the garage if it ever leaks.
function testAuth(req, res, next) {
  const provided = req.headers['x-test-token'] || '';
  const expected = process.env.TEST_CHAT_SECRET || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Health check — verifies Firestore is reachable. Used by Cloud Monitoring uptime check.
app.get('/health', async (req, res) => {
  try {
    await getGarageConfig(); // lightweight Firestore read
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Synthetic monitor — called by Cloud Scheduler every 30 min. Tests Claude + Firestore.
// Uses Haiku (cheapest model) with track:false so it doesn't pollute billing.
app.get('/health/synthetic', async (req, res) => {
  const results = { claude: 'untested', firestore: 'untested' };
  try {
    const reply = await askClaude(
      [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }],
      'You are a test assistant. Follow instructions exactly.',
      'claude-haiku-4-5-20251001',
      { track: false },
    );
    results.claude = reply.trim().toUpperCase().includes('PONG') ? 'ok' : `unexpected: ${reply.slice(0, 50)}`;
  } catch (err) {
    results.claude = `error: ${err.message}`;
  }

  try {
    await getGarageConfig();
    results.firestore = 'ok';
  } catch (err) {
    results.firestore = `error: ${err.message}`;
  }

  const allOk = Object.values(results).every(v => v === 'ok');
  if (!allOk) console.error('Synthetic health check failed:', results);
  res.status(allOk ? 200 : 500).json({ status: allOk ? 'ok' : 'degraded', ...results, ts: new Date().toISOString() });
});

// Inbox web app
app.use('/inbox', express.static(path.join(__dirname, 'web')));

// Staging chat — test the AI directly in a browser without going through Twilio/WhatsApp.
// No Firestore conversation is created, no push notification is sent to Ian, and usage isn't
// billed to him (track: false below) — this is a sandbox, isolated from real customer data.
app.use('/test', express.static(path.join(__dirname, 'test-web')));

// Twilio inbound webhook
const MAX_BODY_LENGTH = 2000;

app.post('/', verifyTwilioSignature, async (req, res) => {
  const from      = req.body.From;
  const to        = req.body.To;
  const messageSid = req.body.MessageSid;
  const numMedia  = parseInt(req.body.NumMedia || '0', 10);
  let body        = req.body.Body?.trim();

  if (!from || !to || !messageSid) return res.status(400).send('Bad request');

  if (!body && numMedia > 0) {
    body = "[Customer sent a photo/attachment — couldn't be read automatically]";
  }
  if (!body) return res.status(400).send('Bad request');

  if (body.length > MAX_BODY_LENGTH) body = body.slice(0, MAX_BODY_LENGTH);

  if (isRateLimited(from)) {
    console.error(`Rate limit hit for ${from}`);
    return res.status(200).send('OK'); // ack Twilio, drop silently rather than reply-spam
  }

  try {
    await handleMessage(from, body, to, messageSid);
  } catch (e) {
    console.error('handleMessage failed:', e);
  }
  res.status(200).send('OK');
});

// Staging chat: behaves like a real SMS conversation — the browser tab holds the running
// thread and sends it in full each turn, so the AI has real context (won't re-introduce
// itself, remembers what was already said). Nothing persists server-side: no Firestore
// write, no Twilio send, no push notification, and usage isn't billed to Ian (track: false).
// Refreshing the page starts a brand new conversation — that's the only "reset".
const MAX_TEST_MESSAGES = 100;

app.post('/test-chat', testAuth, async (req, res) => {
  const { messages, phone } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (messages.length > MAX_TEST_MESSAGES) {
    return res.status(400).json({ error: `too many messages (max ${MAX_TEST_MESSAGES})` });
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) {
      return res.status(400).json({ error: 'each message needs role "user"|"assistant" and non-empty string content' });
    }
  }
  if (phone !== undefined && typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone must be a string' });
  }
  const claudeMessages = messages.map(m => ({
    role:    m.role,
    content: m.content.length > MAX_BODY_LENGTH ? m.content.slice(0, MAX_BODY_LENGTH) : m.content,
  }));

  // Faux phone number lets the tester simulate a known vs. unknown customer, same lookup
  // the real Twilio webhook does — but nothing here is saved to Firestore or billed.
  const customer = phone?.trim() ? await lookupCustomer(phone.trim()) : null;
  const systemPrompt = buildSystemPrompt(customer, getBusinessHoursStatus(), null);

  try {
    const reply      = await askClaude(claudeMessages, systemPrompt, undefined, { track: false });
    const escalated  = reply.includes('[ESCALATE]');
    const cleanReply = reply.replace('[ESCALATE]', '').trim();
    res.json({
      reply: cleanReply,
      escalated,
      customerKnown: !!customer,
      customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : null,
    });
  } catch (e) {
    console.error('test-chat failed:', e);
    res.status(500).json({ error: 'Claude request failed' });
  }
});

// Inbox: list conversations
app.get('/conversations', auth, async (req, res) => {
  const conversations = await getConversations();
  res.json(conversations);
});

// Inbox: single conversation — also marks it read
app.get('/conversations/:phone', auth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const [conv] = await Promise.all([
    getConversation(phone),
    markRead(phone),
  ]);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Inbox: Ian sends a reply
app.post('/reply', auth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  const conv = await getConversation(phone);
  const twilioFrom = conv?.twilioNumber || `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
  const isWhatsApp = twilioFrom.startsWith('whatsapp:');
  const twilioTo   = isWhatsApp ? `whatsapp:${phone}` : phone;
  await sendMessage(twilioFrom, twilioTo, message);
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

// Garage config (away mode etc.)
app.get('/garage-config', auth, async (req, res) => {
  const config = await getGarageConfig();
  res.json(config);
});

app.post('/away', auth, async (req, res) => {
  const { awayUntil } = req.body; // ISO date string or null
  await setGarageConfig({ awayUntil: awayUntil || null });
  res.json({ ok: true });
});

// Billing: Claude API cost tracking + markup for invoicing Ian.
// Defaults to 0% markup — set via POST /billing-config once a rate is agreed.
app.get('/billing-summary', auth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const [usage, garageConfig] = await Promise.all([getUsage(month), getGarageConfig()]);
  const markupPercent = garageConfig?.billingMarkupPercent ?? 0;
  res.json(buildBillingSummary(month, usage, markupPercent));
});

app.post('/billing-config', auth, async (req, res) => {
  const { markupPercent } = req.body;
  if (typeof markupPercent !== 'number' || markupPercent < 0) {
    return res.status(400).json({ error: 'markupPercent must be a non-negative number' });
  }
  await setGarageConfig({ billingMarkupPercent: markupPercent });
  res.json({ ok: true });
});

// Monthly billing report emailed to Jonathan (called by Cloud Scheduler on the
// 1st of each month, reporting the month that just ended)
app.post('/monthly-billing-report', auth, async (req, res) => {
  try {
    const month = previousMonth();
    const usage = await getUsage(month);
    const garageConfig = await getGarageConfig();
    const markupPercent = garageConfig?.billingMarkupPercent ?? 0;
    const summary = buildBillingSummary(month, usage, markupPercent);
    await sendEmail('bleasejonathan@gmail.com', `whatsapp-agent billing — ${month}`, formatBillingEmail(summary));
    res.json({ ok: true });
  } catch (e) {
    console.error('monthly-billing-report failed:', e);
    res.status(500).json({ error: 'failed to send report' });
  }
});

functions.http('whatsappWebhook', app);
