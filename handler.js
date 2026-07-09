const fs   = require('fs');
const path = require('path');

const { getConversation, saveHistory, clearHistory, claimMessage, getGarageConfig } = require('./store');
const { askClaude }      = require('./claude');
const { sendMessage }    = require('./twilio');
const { lookupCustomer } = require('./sheets');
const { sendPush }       = require('./push');

function extractPromptTemplate(fileContents) {
  const match = fileContents.match(/^<!-- PROMPT -->\n([\s\S]*?)\n^<!-- PROMPT END -->$/m);
  if (!match) throw new Error('SYSTEM_PROMPT.md is missing the <!-- PROMPT --> / <!-- PROMPT END --> markers on their own lines');
  return match[1];
}

const PROMPT_TEMPLATE = extractPromptTemplate(
  fs.readFileSync(path.join(__dirname, 'SYSTEM_PROMPT.md'), 'utf8')
);

const RESET_PHRASES = ['reset', 'start over', 'restart'];
const MAX_HISTORY   = 200;

// Inactivity thresholds for conversation state resets
const HUMAN_GRACE_HOURS      = 8;   // keep bot silent for active human takeovers within this window
const NEW_CONVERSATION_HOURS = 24;  // trim context sent to Claude after this gap
const FRESH_START_HOURS      = 168; // 7 days — pass no history to Claude at all

// Returns { open: bool, nextOpen: string } in Europe/London time
function getBusinessHoursStatus() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    hour:    'numeric',
    hour12:  false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday').value; // e.g. "Monday"
  const hour    = parseInt(parts.find(p => p.type === 'hour').value, 10);

  const weekdays   = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const dayIndex   = weekdays.indexOf(weekday); // -1 if weekend
  const isWeekday  = dayIndex !== -1;
  const open       = isWeekday && hour >= 8 && hour < 17;

  let nextOpen;
  if (open) {
    nextOpen = null;
  } else if (isWeekday && hour < 8) {
    nextOpen = 'today at 8am';
  } else if (weekday === 'Friday' || !isWeekday) {
    nextOpen = 'Monday at 8am';
  } else {
    // Mon–Thu after 5pm → next weekday
    nextOpen = `${weekdays[dayIndex + 1]} at 8am`;
  }

  return { open, nextOpen };
}

async function handleMessage(from, body, to, messageSid) {
  const phone = from.replace('whatsapp:', '');

  if (messageSid) {
    const claimed = await claimMessage(messageSid);
    if (!claimed) {
      console.log(`Duplicate delivery of ${messageSid} for ${phone} — skipping`);
      return;
    }
  }

  if (RESET_PHRASES.includes(body.toLowerCase())) {
    await clearHistory(phone);
    await sendMessage(to, from, "No problem, let's start fresh. How can I help you?");
    return;
  }

  // Single Firestore read for all conversation state + customer lookup + garage config in parallel
  const [conv, customer, garageConfig] = await Promise.all([
    getConversation(phone),
    lookupCustomer(phone),
    getGarageConfig(),
  ]);

  const awayUntil      = garageConfig?.awayUntil ? new Date(garageConfig.awayUntil) : null;
  const isActivelyAway = awayUntil && awayUntil > new Date();

  const history   = conv?.messages      || [];
  const status    = conv?.status        || 'bot';
  const lastMsgAt = conv?.lastMessageAt || null;

  const hoursSinceLast = lastMsgAt
    ? (Date.now() - lastMsgAt.getTime()) / (1000 * 60 * 60)
    : Infinity;

  // Ian is actively in this conversation — save the message for him to see, but stay silent
  const isActiveHumanTakeover = status === 'human' && hoursSinceLast < HUMAN_GRACE_HOURS;
  if (isActiveHumanTakeover) {
    const saved = [...history, { role: 'user', content: body, sender: 'customer', ts: new Date().toISOString() }];
    const trimmed = saved.length > MAX_HISTORY ? saved.slice(-MAX_HISTORY) : saved;
    await saveHistory(phone, trimmed, { lastMessage: body, twilioNumber: to, unread: true });
    return;
  }

  // Limit history sent to Claude based on inactivity — full history is always preserved in Firestore
  let contextHistory;
  if (hoursSinceLast >= FRESH_START_HOURS) {
    contextHistory = [];             // 7+ days: completely fresh context
  } else if (hoursSinceLast >= NEW_CONVERSATION_HOURS) {
    contextHistory = history.slice(-5);  // 24h–7d: light context only
  } else {
    contextHistory = history;        // active: full context
  }

  const now          = new Date().toISOString();
  const userMsg      = { role: 'user', content: body, sender: 'customer', ts: now };
  const customerName = customer ? `${customer.firstName} ${customer.lastName}`.trim() : phone;

  // What Claude sees (windowed) vs what gets saved (always the full history)
  const claudeMessages = [...contextHistory, userMsg];

  let reply;
  try {
    reply = await askClaude(
      claudeMessages.map(m => ({ role: m.role, content: m.content })),
      buildSystemPrompt(customer, getBusinessHoursStatus(), isActivelyAway ? awayUntil : null),
    );
  } catch (err) {
    console.error('askClaude failed after retries:', err);
    const fallback    = "Sorry, I'm having a technical hiccup right now — I've flagged this for Ian and he'll get back to you personally as soon as he can.";
    const fallbackMsg = { role: 'assistant', content: fallback, sender: 'bot', ts: new Date().toISOString() };
    const updated     = [...history, userMsg, fallbackMsg];
    const trimmed     = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;
    await Promise.all([
      saveHistory(phone, trimmed, {
        customerName, phone, twilioNumber: to,
        status: 'human', resolved: false, escalated: true,
        lastMessage: fallback.slice(0, 120),
        unread: true,
      }),
      sendMessage(to, from, fallback),
      sendPush(`⚠️ ${customerName} — bot error, needs you`, body),
    ]);
    return;
  }

  const justEscalated  = reply.includes('[ESCALATE]');
  const cleanReply     = reply.replace('[ESCALATE]', '').trim();

  // Claude doesn't reliably suppress [ESCALATE] on repeat turns of the same conversation
  // (observed re-firing on every reply in a multi-turn frustrated-customer test), so the
  // "only notify once" rule is enforced here in code rather than trusted to the prompt.
  // escalated is sticky — once true it stays true (surviving replies that don't re-tag)
  // until Ian resolves the conversation (see setResolved) — otherwise the "Needs Ian"
  // inbox badge could silently clear itself on the next ordinary reply.
  const alreadyEscalated = conv?.escalated === true;
  const escalated         = justEscalated || alreadyEscalated;
  const shouldNotify      = justEscalated && !alreadyEscalated;

  const replyMsg = { role: 'assistant', content: cleanReply, sender: 'bot', ts: new Date().toISOString() };
  const updated  = [...history, userMsg, replyMsg];
  const trimmed  = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;

  await Promise.all([
    saveHistory(phone, trimmed, {
      customerName,
      phone,
      twilioNumber: to,
      status:   'bot', // Ian takes over manually via inbox — [ESCALATE] only notifies, doesn't silence bot
      resolved: false,  // auto-reopen any previously resolved conversation
      escalated,
      lastMessage: cleanReply.slice(0, 120),
      unread: true,
    }),
    sendMessage(to, from, cleanReply),
    ...(shouldNotify ? [sendPush(`⚠️ ${customerName} needs you`, body)] : []),
  ]);
}

function buildSystemPrompt(customer, { open, nextOpen }, awayUntil = null) {
  const garagePhone = process.env.GARAGE_PHONE;
  const garageName  = process.env.GARAGE_NAME;

  const todayStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/London',
  });

  // "Closed for the day" is only accurate if today's opening has already passed — if it's
  // early morning and we simply haven't opened yet, that phrase wrongly implies no more
  // opening today, so use a distinct phrase for that case.
  const closedPhrase = nextOpen === 'today at 8am' ? "hasn't opened yet today" : 'closed for the day';

  const escalationInstructions = open
    ? `The garage is currently open. If the customer is frustrated, the query is too complex, they ask to speak to Ian directly, or you genuinely can't help — include [ESCALATE] at the end of your reply and let them know Ian will be in touch shortly. Only use [ESCALATE] once per conversation — if it's already appeared in a previous reply, Ian has been notified and you should continue helping without using it again.`
    : `The garage is currently ${closedPhrase} and reopens ${nextOpen}. Do not use [ESCALATE] — Ian is not monitoring messages in real time. Take the details, reassure the customer their message is noted, and let them know the garage reopens ${nextOpen} — describe the current state as "${closedPhrase}" (not "closed today"). Stating that reopening time is fine — it's just the garage's normal hours — but don't promise Ian will personally reply at that exact moment, since he may not see it the second he's back. Never suggest calling Ian while closed, even if the customer is frustrated or insistent — he's not expecting calls out of hours. They're welcome to message him directly on ${garagePhone} if they want to add anything, but reassure them their message has already been passed on. If the situation is genuinely urgent and they can't wait (a breakdown, a safety issue), suggest their breakdown provider (RAC/AA) instead.`;

  let prompt = PROMPT_TEMPLATE
    .replaceAll('{garageName}', garageName)
    .replaceAll('{garagePhone}', garagePhone)
    .replaceAll('{today}', todayStr)
    .replaceAll('{openStatus}', open ? 'OPEN' : 'CLOSED')
    .replaceAll('{escalationInstructions}', escalationInstructions);

  if (awayUntil) {
    const dateStr = awayUntil.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    prompt += `\n\nIMPORTANT — IAN IS CURRENTLY AWAY

Ian is on holiday and will not be available until ${dateStr}.
- Do not accept, confirm, or offer any booking slots
- Do not use [ESCALATE]
- Tell customers warmly that Ian is away until ${dateStr} and will be in touch when he's back
- You can still answer questions and give pricing — just make clear no dates can be confirmed until Ian returns
- If someone has an urgent safety issue, acknowledge it and suggest they search for a nearby garage or contact their breakdown provider (RAC/AA)`;
  }

  // base is the cacheable part — identical for all customers within the same hour/status
  // customerContext varies per customer and is appended uncached
  let customerContext = null;
  if (customer) {
    const vehicleList = customer.vehicles.map((v, i) =>
      `  ${i + 1}. ${v.make} ${v.model} (${v.registration}) — MOT: ${v.motExpiry || 'not on record'}`
    ).join('\n');

    customerContext = `CUSTOMER RECORD

This customer is already on the system:
- Name: ${customer.firstName} ${customer.lastName}
- Vehicles:\n${vehicleList}

${customer.vehicles.length > 1
  ? 'They have multiple vehicles. If the query is vehicle-specific, ask which car they are contacting about before proceeding.'
  : 'Use their name naturally and reference their vehicle where relevant.'}

The vehicle information above is background context only — do not use it to validate or question registrations the customer provides. If a customer mentions a different or additional registration, accept it without question. They may have vehicles not yet on the system.

Seeing the MOT date here does NOT mean this enquiry is about the MOT. Do not volunteer the MOT status, or say whether it's due or not, unless the customer actually asks about it or it's clearly relevant to what they raised. Answer what they've actually asked about — they may be contacting you about a service, a noise, tyres, or anything else.`;
  }

  return { base: prompt, customerContext };
}

module.exports = { handleMessage, buildSystemPrompt, getBusinessHoursStatus };
