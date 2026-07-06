const { getHistory, saveHistory, clearHistory, getStatus } = require('./store');
const { askClaude }      = require('./claude');
const { sendMessage }    = require('./twilio');
const { lookupCustomer } = require('./sheets');
const { sendPush }       = require('./push');

const RESET_PHRASES = ['reset', 'start over', 'restart'];
const MAX_HISTORY   = 200;

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

async function handleMessage(from, body, to) {
  const phone = from.replace('whatsapp:', '');

  if (RESET_PHRASES.includes(body.toLowerCase())) {
    await clearHistory(phone);
    await sendMessage(to, from, "No problem, let's start fresh. How can I help you?");
    return;
  }

  // If Ian has taken over, save the customer message so he sees it in the inbox but don't reply
  const status = await getStatus(phone);
  if (status === 'human') {
    const history  = await getHistory(phone);
    const messages = [...history, { role: 'user', content: body, sender: 'customer', ts: new Date().toISOString() }];
    const trimmed  = messages.length > MAX_HISTORY ? messages.slice(-MAX_HISTORY) : messages;
    await saveHistory(phone, trimmed, { lastMessage: body, twilioNumber: to });
    return;
  }

  const [history, customer] = await Promise.all([
    getHistory(phone),
    lookupCustomer(phone),
  ]);

  const messages = [...history, { role: 'user', content: body, sender: 'customer', ts: new Date().toISOString() }];

  const reply = await askClaude(
    messages.map(m => ({ role: m.role, content: m.content })),
    buildSystemPrompt(customer, getBusinessHoursStatus()),
  );

  const escalated  = reply.includes('[ESCALATE]');
  const cleanReply = reply.replace('[ESCALATE]', '').trim();

  const updated = [...messages, { role: 'assistant', content: cleanReply, sender: 'bot', ts: new Date().toISOString() }];
  const trimmed = updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated;

  const customerName = customer ? `${customer.firstName} ${customer.lastName}`.trim() : phone;

  await Promise.all([
    saveHistory(phone, trimmed, {
      customerName,
      phone,
      twilioNumber: to,
      status:      escalated ? 'human' : 'bot',
      escalated,
      lastMessage: cleanReply.slice(0, 120),
    }),
    sendMessage(to, from, cleanReply),
    escalated
      ? sendPush(`⚠️ ${customerName} needs you`, body)
      : sendPush(`💬 ${customerName}`, body),
  ]);
}

function buildSystemPrompt(customer, { open, nextOpen }) {
  const garagePhone = process.env.GARAGE_PHONE;
  const garageName  = process.env.GARAGE_NAME;

  let prompt = `You are a friendly and helpful AI assistant for ${garageName}, a garage and MOT testing station run by Ian.

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

Guidelines:
- Keep messages short and conversational — this is WhatsApp, not email
- If a customer describes a fault, it's fine to offer one or two likely causes to show you understand, but don't turn it into a deep diagnostic back-and-forth — you're not there to fix the car over WhatsApp. Focus on understanding what the customer wants, then steer them towards action (booking in so Ian can take a proper look). The goal is to make the customer feel heard and get them booked in, not to solve the problem in the chat
- When a customer wants to book in, do not confirm or offer specific slots — Ian manages the schedule himself. Instead, find out: what the vehicle needs, the registration, and when would generally suit them. For drop-off, let them know the garage works best with an early drop — ideally between 8am and 9am so Ian can get started on the car first thing and customers can leave it for the day. If they'd prefer a slightly later drop to avoid rush hour traffic, up to 9:30am works too. Let Ian know which they prefer when passing the booking over.
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

module.exports = { handleMessage };
