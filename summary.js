const { getConversations, getConversation } = require('./store');
const { askClaude }  = require('./claude');
const { sendMessage } = require('./twilio');

async function sendDailySummary() {
  const all = await getConversations();

  // Only conversations updated in the last 24 hours
  const cutoff  = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent  = all.filter(c => !c.resolved && c.lastMessageAt && new Date(c.lastMessageAt) > cutoff);

  if (!recent.length) {
    console.log('Daily summary: no conversations in last 24h');
    return;
  }

  // Fetch full message history for each
  const full = await Promise.all(recent.map(c => getConversation(c.phone)));

  // Build a text summary of each conversation for Claude to digest
  const convSummaries = full.map(c => {
    const name = c.customerName || c.phone;
    const msgs = (c.messages || []).map(m => {
      const who = m.sender === 'customer' ? 'Customer' : m.sender === 'ian' ? 'Ian' : 'Bot';
      return `${who}: ${m.content}`;
    }).join('\n');
    return `--- ${name} (${c.phone}) ---\n${msgs}`;
  }).join('\n\n');

  const prompt = `You are summarising today's customer WhatsApp conversations for Ian, the garage owner at CH Autoworks.

Review the conversations below and produce a short daily summary Ian can read in 60 seconds. Include:
- Customers who want to book in (name, vehicle if mentioned, what they need, preferred time if mentioned)
- Customers waiting for a response or who need Ian's attention
- Any escalated or complex issues

Be concise. Use bullet points. If nothing needs action, say so.

Conversations:
${convSummaries}`;

  const summary = await askClaude([{ role: 'user', content: prompt }], 'You are a helpful assistant summarising garage customer conversations.');

  const garageName  = process.env.GARAGE_NAME;
  const garagePhone = process.env.GARAGE_PHONE;
  const twilioFrom  = `whatsapp:+${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^\+/, '')}`;
  const twilioTo    = `whatsapp:+44${garagePhone.replace(/^0/, '')}`;

  const message = `*${garageName} — Daily Summary*\n\n${summary}`;
  await sendMessage(twilioFrom, twilioTo, message);

  console.log(`Daily summary sent to ${twilioTo}`);
}

// Returns the UTC timestamp of midnight today in Europe/London time (handles BST/GMT automatically)
function ukMidnightToday() {
  const nowUtc    = new Date();
  const nowLondon = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const midnight  = new Date(nowLondon);
  midnight.setHours(0, 0, 0, 0);
  const utcOffset = nowUtc - nowLondon;
  return new Date(midnight.getTime() + utcOffset);
}

async function getInboxSummary() {
  const all    = await getConversations();
  const cutoff = ukMidnightToday(); // everything since midnight UK time today

  // Include all conversations active today — resolved or not
  const today = all.filter(c => c.lastMessageAt && new Date(c.lastMessageAt) >= cutoff);

  if (!today.length) return null; // nothing today yet

  const full = await Promise.all(today.map(c => getConversation(c.phone)));

  const convSummaries = full.map(c => {
    const name = c.customerName || c.phone;
    const msgs = (c.messages || []).slice(-8).map(m => {
      const who = m.sender === 'customer' ? 'Customer' : m.sender === 'ian' ? 'Ian' : 'Bot';
      return `${who}: ${m.content}`;
    }).join('\n');

    let statusTag;
    if (c.resolved)              statusTag = '[RESOLVED TODAY]';
    else if (c.escalated)        statusTag = '[NEEDS IAN]';
    else if (c.status === 'human') statusTag = '[IAN HANDLING]';
    else                         statusTag = '[BOT]';

    return `${statusTag} ${name}\n${msgs}`;
  }).join('\n\n');

  const prompt = `Summarise today's customer conversations for Ian at CH Autoworks. Be very brief — one line per item max, bullet points only.

Group into two sections:
• **Needs attention** — customers waiting for a reply, unresolved bookings, escalated issues
• **Dealt with today** — resolved conversations, completed bookings

If a section is empty, omit it entirely.

Conversations:
${convSummaries}`;

  return await askClaude(
    [{ role: 'user', content: prompt }],
    'You are a brief assistant summarising garage customer messages for the owner.',
    'claude-haiku-4-5-20251001',
  );
}

module.exports = { sendDailySummary, getInboxSummary };
