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

async function getInboxSummary() {
  const all    = await getConversations();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recent = all.filter(c => !c.resolved && c.lastMessageAt && new Date(c.lastMessageAt) > cutoff);

  if (!recent.length) return 'No recent conversations.';

  const full = await Promise.all(recent.map(c => getConversation(c.phone)));

  const convSummaries = full.map(c => {
    const name = c.customerName || c.phone;
    const msgs = (c.messages || []).slice(-6).map(m => {
      const who = m.sender === 'customer' ? 'Customer' : m.sender === 'ian' ? 'Ian' : 'Bot';
      return `${who}: ${m.content}`;
    }).join('\n');
    const status = c.escalated ? '[NEEDS IAN]' : c.status === 'human' ? '[IAN HANDLING]' : '[BOT]';
    return `${status} ${name}\n${msgs}`;
  }).join('\n\n');

  const prompt = `Summarise these recent garage customer conversations for Ian in 3-5 bullet points. Focus only on what needs action: bookings to make, customers waiting for a reply, urgent issues. Be very brief — one line per item maximum.

${convSummaries}`;

  return await askClaude([{ role: 'user', content: prompt }], 'You are a brief assistant summarising garage customer messages for the owner.');
}

module.exports = { sendDailySummary, getInboxSummary };
