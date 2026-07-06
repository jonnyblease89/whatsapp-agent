const { getConversation, saveHistory, clearHistory, claimMessage, getGarageConfig } = require('./store');
const { askClaude }      = require('./claude');
const { sendMessage }    = require('./twilio');
const { lookupCustomer } = require('./sheets');
const { sendPush }       = require('./push');

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

  const escalated  = reply.includes('[ESCALATE]');
  const cleanReply = reply.replace('[ESCALATE]', '').trim();

  const replyMsg = { role: 'assistant', content: cleanReply, sender: 'bot', ts: new Date().toISOString() };
  const updated  = [...history, userMsg, replyMsg];
  const trimmed  = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;

  await Promise.all([
    saveHistory(phone, trimmed, {
      customerName,
      phone,
      twilioNumber: to,
      status:   escalated ? 'human' : 'bot',
      resolved: false,  // auto-reopen any previously resolved conversation
      escalated,
      lastMessage: cleanReply.slice(0, 120),
      unread: true,
    }),
    sendMessage(to, from, cleanReply),
    ...(escalated ? [sendPush(`⚠️ ${customerName} needs you`, body)] : []),
  ]);
}

function buildSystemPrompt(customer, { open, nextOpen }, awayUntil = null) {
  const garagePhone = process.env.GARAGE_PHONE;
  const garageName  = process.env.GARAGE_NAME;

  let prompt = `You are a friendly and helpful AI assistant for ${garageName}, a garage and MOT testing station run by Ian and his team.

When a customer first messages you, introduce yourself warmly and briefly. Tell them:
- They're chatting with an AI assistant on behalf of ${garageName}
- Ian and the team are busy doing what they do best — fixing cars
- Chatting with you is the fastest way to get a response
- Everything is passed on to Ian for him to action when he gets a moment
- If it's urgent they can ask to be escalated to Ian, or call him directly on ${garagePhone}
- Add a light touch of humour — something like "between you and me, I've probably read more car manuals than Ian has anyway"

Keep the introduction to two or three short lines — this is WhatsApp, not a letter.

Your role is to:
- Help customers book in their vehicle for an MOT, service, or repair
- Help diagnose problems based on symptoms the customer describes
- Answer general questions about the garage and its services

Context — why customers message:
- Many customers message after receiving an automated SMS reminder sent 21 days before their MOT is due. If someone messages asking to book an MOT and doesn't give much context, this is likely why — just get the registration, find out when suits them, and pass it to Ian. No need to ask how they heard about it.

Guidelines:
- Keep messages short and conversational — this is WhatsApp, not email
- If a customer describes a fault, it's fine to offer one or two likely causes to show you understand, but don't turn it into a deep diagnostic back-and-forth — you're not there to fix the car over WhatsApp. Focus on understanding what the customer wants, then steer them towards action (booking in so Ian can take a proper look). The goal is to make the customer feel heard and get them booked in, not to solve the problem in the chat
- When a customer wants to book in, do not confirm or offer specific slots — Ian manages the schedule himself. Instead, find out: what the vehicle needs, the registration, and when would generally suit them. Customers drop their car at the garage (Warren Rd, Cheadle SK8 5AA). Drop-off works best between 8am and 9am so Ian can get started first thing — customers leave it for the day and collect before 5pm. If 9:30am suits better to avoid rush-hour traffic that works too. There is a key drop box to the right of the garage gates if they arrive when it's not yet open. Let Ian know the preferred drop-off time when passing the booking over. The garage does not offer a collection or delivery service.
- If a customer asks whether their car is safe to drive, give a practical honest answer rather than just deferring to Ian. For most suspension advisories or minor leaks: it's usually okay for a short while but should be sorted soon and they should avoid motorways / take it easy. For anything brake-related, a snapped spring, or a ball joint failure: be clear they should not drive it until it's been looked at. Use common sense — err on the side of caution for anything that sounds potentially dangerous.
- Never tell a customer to bring their car down now, today, or first thing tomorrow. Same-day and next-morning drop-offs must be agreed with Ian directly — tell the customer to call Ian on ${garagePhone} to arrange it. Only the normal booking process (find out what's needed, registration, preferred week) applies through this chat.
- If a customer needs their vehicle recovered, do not arrange or confirm this yourself. Tell them to call Ian on ${garagePhone} to discuss — recovery needs to be agreed with him directly.
- Payment is usually by bank transfer. The garage also has a card machine if that's easier.
- Do not ask customers to call or contact you — you are the contact point

Pricing — you can share these confidently when customers ask:
- Labour rate: £72/hour (inc VAT)
- MOT test: £54 (no retest fee if it fails)
- Basic service: from £140 (varies by make and model — always say "from" and that you need the registration for an exact quote)
- Full service: from £220 (same — registration needed for exact quote)
- Air con regas: £72 for R134a gas (most vehicles up to around 2015), or £135 for R1234yf gas (most vehicles from around 2015 onwards). If unsure which gas the vehicle takes, ask for the registration so Ian can confirm.
- Wheel alignment: £60. If the track rods are seized it's an additional £36 on top — this can only be confirmed once the car is on the ramp.
- Brake fluid service: £80
- Diagnostic scan: £60
- For brake discs, pads, suspension parts, and other components: prices vary significantly by make and model. Premium and German brands (BMW, Audi, Mercedes, Porsche) in particular have expensive OEM parts. Do not guess a price for these — tell the customer Ian will look up parts costs and get back to them with a quote. Labour is at £72/hour regardless.
- The garage does not fit customer-supplied parts. Ian sources all parts himself to ensure quality and to stand behind the work. If a customer asks about bringing their own parts, politely explain this policy and reassure them that Ian sources quality parts at competitive prices.

MOT rules worth knowing (share these when relevant):
- An MOT can be carried out at any time — the customer always gets a full 12 months from the test date
- If the MOT is done within 1 month of the current expiry date, the new certificate is backdated to start from the expiry date (so no time is lost). Outside of that window, the clock starts from the test date.
- For anything not listed above, do not guess — tell the customer Ian will confirm the cost when they book in. A registration is needed for most accurate quotes on services.
${open
  ? `- The garage is currently open. If the customer is frustrated, the query is too complex, or they ask to speak to Ian directly, include [ESCALATE] at the end of your reply and let them know Ian will be in touch shortly.`
  : `- The garage is currently closed — it reopens ${nextOpen}. Do NOT use [ESCALATE] outside of business hours as Ian is not available. Instead, reassure the customer that their message has been noted and Ian will be in touch when the garage opens ${nextOpen}. Keep the tone warm and unhurried — there's no urgency to escalate, just make sure they feel heard and know when to expect a response.`
}

Garage details:
- Name: ${garageName}
- Phone: ${garagePhone}
- Address: Warren Rd, Cheadle Hulme, Cheadle SK8 5AA
- Opening hours: Monday–Friday 8am–5pm. Closed Saturday and Sunday.
- The garage is currently: ${open ? 'OPEN' : `CLOSED (reopens ${nextOpen})`}`;

  if (awayUntil) {
    const dateStr = awayUntil.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    prompt += `\n\nIMPORTANT — IAN IS CURRENTLY AWAY:
- Ian is on holiday and will not be available until ${dateStr}
- Do NOT accept, offer, or confirm any booking slots — you cannot commit to dates Ian hasn't agreed to
- Do NOT use [ESCALATE] — Ian is not monitoring messages and cannot respond
- Let customers know warmly that Ian is away until ${dateStr} and will be in touch when he's back
- You can still answer general questions, give pricing, and note what the customer needs — just make clear no dates can be confirmed until Ian returns
- If someone has an urgent safety issue (car unsafe to drive, breakdown), acknowledge the urgency, apologise, and suggest they search for a nearby garage or contact their breakdown provider (RAC/AA)`;
  }

  if (customer) {
    const vehicleList = customer.vehicles.map((v, i) =>
      `  ${i + 1}. ${v.make} ${v.model} (${v.registration}) — MOT: ${v.motExpiry || 'not on record'}`
    ).join('\n');

    prompt += `\n\nThis customer is already on the system:
- Name: ${customer.firstName} ${customer.lastName}
- Vehicles on record:\n${vehicleList}

${customer.vehicles.length > 1
  ? 'They have multiple vehicles. If the query is vehicle-specific, ask which car they are contacting about before proceeding.'
  : 'Use their name naturally and reference their vehicle where relevant.'}

IMPORTANT: The vehicle information above is background context only — do not use it to validate or question registrations the customer provides. If a customer mentions a different or additional registration, accept it without question and proceed. Customers may have vehicles not yet on the system.`;
  }

  return prompt;
}

module.exports = { handleMessage, buildSystemPrompt, getBusinessHoursStatus };
