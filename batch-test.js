#!/usr/bin/env node
/**
 * Batch scenario runner — calls the real Claude API with the live system prompt.
 * Usage: node batch-test.js > transcripts.md
 * Progress printed to stderr so it doesn't pollute the markdown output.
 */

const fs   = require('fs');
const path = require('path');

function loadEnv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*['"]?(.*?)['"]?\s*$/);
    if (m && m[1] && m[2]) process.env[m[1]] = m[2];
  }
}
loadEnv(path.join(__dirname, '.env.yaml'));

const { buildSystemPrompt } = require('./handler');
const Anthropic = require('@anthropic-ai/sdk');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OPEN   = { open: true,  nextOpen: null };
const CLOSED = { open: false, nextOpen: 'Monday at 8am' };

const SINGLE_VEHICLE_CUSTOMER = {
  firstName: 'Paul',
  lastName:  'Harrison',
  vehicles: [
    { make: 'Toyota', model: 'Yaris', registration: 'PH18 XYZ', motExpiry: '14 Aug 2026' }
  ],
};

const MULTI_VEHICLE_CUSTOMER = {
  firstName: 'Rachel',
  lastName:  'Davies',
  vehicles: [
    { make: 'Volkswagen', model: 'Golf',   registration: 'RD19 AAA', motExpiry: '03 Oct 2026' },
    { make: 'MINI',       model: 'Cooper', registration: 'RD21 BBB', motExpiry: '22 Jan 2027' },
  ],
};

const scenarios = [
  {
    title:       'Scenario 1: Basic MOT booking from reminder text',
    description: 'Unknown customer responding to the automated MOT reminder SMS. Simple, common case.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, just got your text about my MOT being due",
      "Ford Focus, reg AB12 CDE",
      "I'm pretty flexible — any time next week works, prefer morning",
      "Do I need to stay or can I leave it?",
    ],
  },
  {
    title:       'Scenario 2: Car won\'t start — wants to come down now',
    description: 'Customer with a dead car pushing to be seen immediately or first thing tomorrow.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, my car won't start — just clicking when I turn the key. Can I bring it down now?",
      "It's a 2017 Vauxhall Astra, reg DV17 ABC",
      "I really need it for work tomorrow, can I come first thing in the morning?",
      "So what should I do in the meantime?",
    ],
  },
  {
    title:       'Scenario 3: Knocking noise — is it safe to drive?',
    description: 'Customer with a front suspension noise, worried ahead of a motorway trip this weekend.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, my car is making a knocking noise from the front when I go over bumps",
      "It's a VW Golf 2019, reg SJ19 VPK",
      "Is it safe to drive? I've got a motorway trip this weekend",
      "How much do you think it might cost to fix?",
      "OK can I get it booked in then",
    ],
  },
  {
    title:       'Scenario 4: Customer wants to supply their own parts',
    description: 'Customer has bought brake pads online and wants Ian to just fit them.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, I need my front brake pads changing. I've already bought Brembo pads from ECP — can you just fit them?",
      "They're quality parts, not cheap ones",
      "Why won't you fit them? Seems a bit jobsworth to be honest",
      "Fine — how much would it be if you supply the pads instead?",
    ],
  },
  {
    title:       'Scenario 5: Out of hours — weekend service booking',
    description: 'Customer messages on a Saturday evening wanting to book a full service.',
    hours:    CLOSED,
    customer: null,
    messages: [
      "Hi, I want to book my car in for a full service",
      "It's a 2020 Honda Civic, reg KN20 TYU",
      "How much would that roughly be?",
      "OK I'll wait til Monday, just wanted to get it booked",
    ],
  },
  {
    title:       'Scenario 6: Known customer, multiple vehicles — MOT booking',
    description: 'Recognised customer with two cars on the system. AI should ask which vehicle before proceeding.',
    hours:    OPEN,
    customer: MULTI_VEHICLE_CUSTOMER,
    messages: [
      "Hi Rachel, I need to book an MOT please",
      "The Golf",
      "I work from home so any time next week is fine",
      "Brilliant, thanks",
    ],
  },
  {
    title:       'Scenario 7: Air con not working — quote and booking',
    description: 'Customer asking about air con regas on a BMW, wants a price and to book in.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, my air con has stopped working — just blows warm air even on full cold",
      "It's a 2019 BMW 3 Series, reg KP19 RGF",
      "How much would a regas cost?",
      "Can I get booked in for next week?",
    ],
  },
  {
    title:       'Scenario 8: Grinding brakes — dangerous fault, wants to come tomorrow',
    description: 'Customer with a potentially dangerous brake issue pushing to be seen first thing tomorrow.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, my car is making a really bad grinding noise every time I brake — it's got worse over the last couple of days",
      "Can I bring it down first thing tomorrow morning?",
      "Should I even be driving it?",
      "What's the best thing to do — I live about 8 miles away",
    ],
  },
  {
    title:       'Scenario 9: MOT + service combo — known single-vehicle customer',
    description: 'Recognised customer on the system wanting both MOT and service, asks about cost.',
    hours:    OPEN,
    customer: SINGLE_VEHICLE_CUSTOMER,
    messages: [
      "Hi, I think my MOT is coming up soon and I'd like to get a service done at the same time",
      "Yes let's do both",
      "Roughly how much is that likely to be?",
      "Thursday or Friday next week suit you?",
    ],
  },
  {
    title:       'Scenario 10: Frustrated customer — wants to speak to Ian directly',
    description: 'Customer annoyed after a high quote elsewhere, pushes to escalate to Ian.',
    hours:    OPEN,
    customer: null,
    messages: [
      "Hi, another garage has quoted me £800 for a timing chain replacement — is that about right?",
      "It's a Ford Focus 1.0 Ecoboost 2015, reg FP15 XYZ",
      "Look I just want to speak to Ian directly — can you put me through to him?",
    ],
  },
];

async function runScenario(scenario) {
  const systemPrompt = buildSystemPrompt(scenario.customer, scenario.hours);
  const history      = [];
  const lines        = [];

  lines.push(`## ${scenario.title}`);
  lines.push('');
  lines.push(`> ${scenario.description}`);
  lines.push('');

  const hoursTag    = scenario.hours.open ? '🟢 Business hours' : '🔴 Out of hours';
  const customerTag = scenario.customer
    ? `👤 Known customer: ${scenario.customer.firstName} ${scenario.customer.lastName} (${scenario.customer.vehicles.map(v => v.registration).join(', ')})`
    : '👤 Unknown customer';
  lines.push(`**${hoursTag}  ·  ${customerTag}**`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const userMsg of scenario.messages) {
    lines.push(`**Customer:** ${userMsg}`);
    lines.push('');

    history.push({ role: 'user', content: userMsg });

    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 500,
      system:     systemPrompt,
      messages:   history,
    });

    const reply       = response.content[0].text;
    const hasEscalate = reply.includes('[ESCALATE]');
    const clean       = reply.replace('[ESCALATE]', '').trim();

    history.push({ role: 'assistant', content: clean });

    lines.push(`**AI:** ${clean}`);
    lines.push('');
    if (hasEscalate) {
      lines.push('> ⚠️ `[ESCALATE]` triggered — conversation handed to Ian');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const date = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  let output = `# CH Autoworks AI — Prompt Test Transcripts\n\n`;
  output += `**Generated:** ${date}\n\n`;
  output += `These transcripts were produced by running real multi-turn conversations through the live system prompt and \`claude-sonnet-4-6\` — identical model and prompt to what customers experience.\n\n`;
  output += `---\n\n`;

  for (let i = 0; i < scenarios.length; i++) {
    process.stderr.write(`[${i + 1}/${scenarios.length}] ${scenarios[i].title}\n`);
    output += await runScenario(scenarios[i]);
  }

  process.stdout.write(output);
  process.stderr.write('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
