#!/usr/bin/env node
/**
 * CH Autoworks — AI Prompt Tester
 *
 * Usage:
 *   node test.js                  # unknown customer, real business hours
 *   node test.js --closed         # simulate out-of-hours
 *   node test.js --customer       # inject a known test customer
 *   node test.js --closed --customer
 *
 * Commands during chat:
 *   reset   — clear conversation history and start over
 *   exit    — quit
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// Parse .env.yaml without a yaml library — it's a simple key: value file
function loadEnv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*['"]?(.*?)['"]?\s*$/);
    if (m && m[1] && m[2]) process.env[m[1]] = m[2];
  }
}
loadEnv(path.join(__dirname, '.env.yaml'));

const { buildSystemPrompt, getBusinessHoursStatus } = require('./handler');
const Anthropic = require('@anthropic-ai/sdk');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Test customer — simulates a recognised customer from the Google Sheet
const TEST_CUSTOMER = {
  firstName: 'Sarah',
  lastName:  'Johnson',
  vehicles: [
    { make: 'Ford', model: 'Focus', registration: 'AB12 CDE', motExpiry: '15 Sep 2026' },
  ],
};

// Args
const args        = process.argv.slice(2);
const forceClose  = args.includes('--closed');
const useCustomer = args.includes('--customer');

// Build the exact same system prompt the live function uses
const hoursStatus  = forceClose ? { open: false, nextOpen: 'Monday at 8am' } : getBusinessHoursStatus();
const customer     = useCustomer ? TEST_CUSTOMER : null;
const systemPrompt = buildSystemPrompt(customer, hoursStatus);

// ANSI colours
const cyan  = s => `\x1b[36m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const grey  = s => `\x1b[90m${s}\x1b[0m`;
const bold  = s => `\x1b[1m${s}\x1b[0m`;
const red   = s => `\x1b[31m${s}\x1b[0m`;

let history = [];

async function chat(userMessage) {
  history.push({ role: 'user', content: userMessage });
  const response = await client.messages.create({
    model:    'claude-sonnet-4-6',
    max_tokens: 500,
    system:   systemPrompt,
    messages: history,
  });
  const reply = response.content[0].text;
  history.push({ role: 'assistant', content: reply });
  return reply;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const hoursLabel    = hoursStatus.open
  ? green('OPEN')
  : grey(`CLOSED — reopens ${hoursStatus.nextOpen}`);
const customerLabel = customer
  ? cyan(`known: ${customer.firstName} ${customer.lastName} — ${customer.vehicles[0].make} ${customer.vehicles[0].model} (${customer.vehicles[0].registration})`)
  : grey('unknown customer');

console.log(bold('\n── CH Autoworks AI Prompt Tester ──────────────────'));
console.log(`Hours:    ${hoursLabel}`);
console.log(`Customer: ${customerLabel}`);
console.log(grey("Type 'reset' to clear history, 'exit' to quit\n"));

function prompt() {
  rl.question(cyan('You: '), async input => {
    const text = input.trim();
    if (!text) return prompt();

    if (text.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    if (text.toLowerCase() === 'reset') {
      history = [];
      console.log(grey('\n— conversation reset —\n'));
      return prompt();
    }

    try {
      const reply = await chat(text);

      // Flag if escalation was triggered
      const hasEscalate = reply.includes('[ESCALATE]');
      const clean       = reply.replace('[ESCALATE]', '').trim();

      console.log(green(`\nAI: ${clean}`));
      if (hasEscalate) console.log(red('   ⚠ [ESCALATE] triggered'));
      console.log();
    } catch (err) {
      console.error(red(`Error: ${err.message}`));
    }

    prompt();
  });
}

prompt();
