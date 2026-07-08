#!/usr/bin/env node
/**
 * Replays real customer conversations from the CSV log against the new system prompt.
 * Skips MOT reminder-only exchanges. Outputs a markdown file for review.
 * Usage: node replay-transcripts.js /path/to/sms-log.csv
 */

const fs   = require('fs');
const path = require('path');

function loadEnv(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^(\w+):\s*['"]?(.*?)['"]?\s*$/);
      if (m && m[1] && m[2]) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}
loadEnv(path.join(__dirname, '.env.yaml'));

const Anthropic = require('@anthropic-ai/sdk');

// Load system prompt from SYSTEM_PROMPT.md (same logic as handler.js)
function loadSystemPrompt() {
  const raw   = fs.readFileSync(path.join(__dirname, 'SYSTEM_PROMPT.md'), 'utf8');
  const match = raw.match(/^<!-- PROMPT -->\n([\s\S]*?)\n^<!-- PROMPT END -->$/m);
  if (!match) throw new Error('SYSTEM_PROMPT.md missing markers');

  const now     = new Date();
  const parts   = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', hour: 'numeric', hour12: false,
  }).formatToParts(now);
  const weekday   = parts.find(p => p.type === 'weekday').value;
  const hour      = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const weekdays  = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const dayIndex  = weekdays.indexOf(weekday);
  const isWeekday = dayIndex !== -1;
  const open      = isWeekday && hour >= 8 && hour < 17;

  const todayStr = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/London',
  });

  const escalation = open
    ? `The garage is currently open. If the customer is frustrated, the query is too complex, they ask to speak to Ian directly, or you genuinely can't help — include [ESCALATE] at the end of your reply and let them know Ian will be in touch shortly.`
    : `The garage is currently closed. Do not use [ESCALATE] — Ian is not monitoring messages in real time. Take the details, reassure the customer their message is noted, and tell them Ian will be in touch when he's next in.`;

  return match[1]
    .replaceAll('{garageName}',              process.env.GARAGE_NAME  || 'CH Autoworks')
    .replaceAll('{garagePhone}',             process.env.GARAGE_PHONE || '07393031910')
    .replaceAll('{today}',                   todayStr)
    .replaceAll('{openStatus}',              open ? 'OPEN' : 'CLOSED')
    .replaceAll('{escalationInstructions}',  escalation);
}

const GARAGE_SMS  = '+447463580103';
const GARAGE_WA   = '+14155238886';   // WhatsApp sandbox (without whatsapp: prefix)

function normalise(num) {
  return String(num || '').replace('whatsapp:', '').trim();
}

function isGarageNumber(num) {
  const n = normalise(num);
  return n === GARAGE_SMS || n === GARAGE_WA;
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(content) {
  // Normalise line endings
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows  = [];
  let i = 0;

  while (i < text.length) {
    const fields = [];
    // Parse one row
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '"') {
        i++;
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else                     { i++; break; }
          } else {
            field += text[i++];
          }
        }
        fields.push(field);
        if (text[i] === ',') i++;
      } else {
        // Unquoted field (shouldn't normally happen in this CSV but handle it)
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n') field += text[i++];
        fields.push(field);
        if (text[i] === ',') i++;
      }
    }
    if (i < text.length) i++; // skip \n
    if (fields.length > 1) rows.push(fields);
  }

  return rows;
}

function loadMessages(csvPath) {
  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);
  // row: From,To,Body,Status,SentDate,ApiVersion,NumSegments,ErrorCode,...Direction...

  const HEADERS = rows[0].map(h => h.trim());
  const idx = k => HEADERS.indexOf(k);
  const iFrom = idx('From'), iTo = idx('To'), iBody = idx('Body'),
        iDate = idx('SentDate'), iDir = idx('Direction');

  const messages = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 5) continue;

    const from      = normalise(row[iFrom]);
    const to        = normalise(row[iTo]);
    const body      = (row[iBody] || '').trim();
    const sentDate  = new Date(row[iDate]);
    const direction = (row[iDir] || '').trim();

    if (!body) continue;

    // Skip MOT reminders (sent from 'CHAutoworks' sender or the reminder text itself)
    if (from === 'CHAutoworks' || row[iFrom] === 'CHAutoworks') continue;
    if (body.startsWith('Hi ') && body.includes('reminder from CH Autoworks')) continue;

    // Skip daily summary messages to Ian
    if (to === '07393031910' || to === '+447393031910') continue;

    // Skip test/joke exchanges (Jon and Ian goofing)
    const junkPhrases = ['Fuck off', 'Blocks number', 'Its me speaking', 'join straight-whale', 'Boom', 'We are shut', 'We won\'t be dropping'];
    if (junkPhrases.some(p => body.startsWith(p))) continue;

    const isInbound  = direction === 'inbound';
    const customer   = isInbound ? from : to;

    messages.push({ from, to, body, sentDate, direction, isInbound, customer });
  }

  // Sort chronologically
  messages.sort((a, b) => a.sentDate - b.sentDate);
  return messages;
}

function groupByCustomer(messages) {
  const map = new Map();
  for (const m of messages) {
    if (isGarageNumber(m.customer)) continue; // shouldn't happen but guard
    if (!map.has(m.customer)) map.set(m.customer, []);
    map.get(m.customer).push(m);
  }
  return map;
}

function extractCustomerName(msgs) {
  // Bot sometimes opens with "Hi [Name]!" — extract it
  for (const m of msgs) {
    if (!m.isInbound) {
      const match = m.body.match(/^(?:Hey|Hi) (\w[\w '-]+?)[!,\.\n]/);
      if (match && match[1] && !['Ian', 'CH', 'there'].includes(match[1])) {
        return match[1];
      }
    }
  }
  return null;
}

function describeConversation(msgs) {
  const first = msgs.find(m => m.isInbound);
  return first ? first.body.slice(0, 120).replace(/\n/g, ' ') : '';
}

// ── Replay ────────────────────────────────────────────────────────────────────

async function replayConversation(customerMsgs, systemPrompt, client) {
  const history   = [];
  const exchanges = [];

  for (const msg of customerMsgs) {
    history.push({ role: 'user', content: msg.body });

    const resp  = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   history,
    });

    const reply = resp.content[0].text.replace('[ESCALATE]', '').trim();
    history.push({ role: 'assistant', content: reply });
    exchanges.push({ customerMsg: msg.body, botReply: reply });

    await new Promise(r => setTimeout(r, 400));
  }

  return exchanges;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) { console.error('Usage: node replay-transcripts.js <csv-file>'); process.exit(1); }

  const outPath = path.join(__dirname, 'replay-results.md');
  const client  = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  process.stderr.write('Parsing CSV...\n');
  const messages      = loadMessages(csvPath);
  const byCustomer    = groupByCustomer(messages);

  // Filter to conversations with meaningful inbound content
  const convos = [];
  for (const [phone, msgs] of byCustomer) {
    const inbound = msgs.filter(m => m.isInbound);
    if (!inbound.length) continue;
    // Skip if the only inbound message is a one-word reply (e.g. "No." "Yes.")
    if (inbound.length === 1 && inbound[0].body.length < 5) continue;
    convos.push({ phone, msgs, inbound });
  }

  // Sort by first inbound message timestamp
  convos.sort((a, b) => a.inbound[0].sentDate - b.inbound[0].sentDate);

  process.stderr.write(`Found ${convos.length} real conversations.\n\n`);

  const systemPrompt = loadSystemPrompt();

  let md = `# CH Autoworks — Prompt Replay Results\n\n`;
  md += `Real customer messages from 6–7 July 2026 replayed against the **new system prompt**.\n`;
  md += `Generated: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}\n`;
  md += `Today as seen by bot: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' })}\n\n`;
  md += `---\n\n`;

  for (let i = 0; i < convos.length; i++) {
    const { phone, msgs, inbound } = convos[i];
    const name    = extractCustomerName(msgs);
    const label   = name ? `${name} (${phone})` : phone;
    const summary = describeConversation(msgs);

    process.stderr.write(`[${i+1}/${convos.length}] ${label} — ${inbound.length} customer message(s)...\n`);

    md += `## ${i+1}. ${label}\n\n`;
    md += `**Opening:** _${summary}_\n\n`;

    try {
      const exchanges = await replayConversation(inbound, systemPrompt, client);
      for (const ex of exchanges) {
        md += `**Customer:** ${ex.customerMsg.replace(/\n/g, '  \n> ')}\n\n`;
        md += `**New bot:** ${ex.botReply.replace(/\n/g, '  \n')}\n\n`;
        md += `---\n\n`;
      }
    } catch (err) {
      process.stderr.write(`  ERROR: ${err.message}\n`);
      md += `_Error replaying conversation: ${err.message}_\n\n---\n\n`;
    }
  }

  fs.writeFileSync(outPath, md, 'utf8');
  process.stderr.write(`\nWritten: ${outPath}\n`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
