#!/usr/bin/env node
/**
 * Pulls real conversations from the live API and prints readable transcripts.
 * Usage: node pull-transcripts.js
 *        node pull-transcripts.js --hours 48   (last N hours, default 48)
 *        node pull-transcripts.js --all
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

function loadEnv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*['"]?(.*?)['"]?\s*$/);
    if (m && m[1] && m[2]) process.env[m[1]] = m[2];
  }
}
loadEnv(path.join(__dirname, '.env.yaml'));

const API    = 'https://europe-west2-trans-invention-392414.cloudfunctions.net/whatsapp-agent';
const SECRET = process.env.INBOX_SECRET;

function apiFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const url = API + urlPath;
    const req = https.get(url, {
      headers: { 'x-inbox-token': SECRET },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

const args  = process.argv.slice(2);
const all   = args.includes('--all');
const hours = all ? Infinity : parseInt(args[args.indexOf('--hours') + 1] || '48', 10);

async function main() {
  process.stderr.write('Fetching conversation list...\n');
  const list = await apiFetch('/conversations');

  if (!Array.isArray(list)) {
    console.error('Unexpected response:', list);
    process.exit(1);
  }

  const cutoff = all ? new Date(0) : new Date(Date.now() - hours * 60 * 60 * 1000);
  const recent = list.filter(c => c.lastMessageAt && new Date(c.lastMessageAt) >= cutoff);

  if (!recent.length) {
    console.log(`No conversations found${all ? '' : ` in the last ${hours}h`}.`);
    return;
  }

  process.stderr.write(`Fetching ${recent.length} conversation(s)...\n`);

  // Fetch full message history for each
  const full = [];
  for (const c of recent) {
    const detail = await apiFetch(`/conversations/${encodeURIComponent(c.phone)}`);
    full.push(detail);
    process.stderr.write(`  ✓ ${detail.customerName || detail.phone}\n`);
  }

  console.log('='.repeat(80));
  console.log(`CH Autoworks — Real Customer Transcripts`);
  console.log(`Pulled: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
  console.log(`Window: ${all ? 'all time' : `last ${hours} hours`}  |  ${full.length} conversation(s)`);
  console.log('='.repeat(80));

  for (const c of full) {
    const name      = c.customerName || c.phone;
    const lastAt    = c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : '—';
    const statusTag = c.resolved ? '[RESOLVED]' : c.escalated ? '[ESCALATED]' : c.status === 'human' ? '[HUMAN]' : '[BOT]';
    const channel   = (c.twilioNumber || '').startsWith('+1415') ? 'WhatsApp' : 'SMS';

    console.log(`\n## ${name}  ${statusTag}  · ${channel}`);
    console.log(`Phone: ${c.phone}  |  Last active: ${lastAt}`);
    console.log('-'.repeat(60));

    const messages = c.messages || [];
    if (!messages.length) {
      console.log('(no messages stored)');
    } else {
      for (const m of messages) {
        const ts     = m.ts ? new Date(m.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '??:??';
        const sender = m.sender === 'customer' ? 'CUSTOMER' : m.sender === 'ian' ? 'IAN     ' : 'BOT     ';
        const lines  = String(m.content || '').split('\n');
        console.log(`[${ts}] ${sender}  ${lines[0]}`);
        for (const l of lines.slice(1)) {
          if (l.trim()) console.log(`               ${l}`);
        }
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  // Stats
  const escalated = full.filter(c => c.escalated).length;
  const resolved  = full.filter(c => c.resolved).length;
  const humanMode = full.filter(c => !c.escalated && c.status === 'human').length;
  const botOnly   = full.filter(c => !c.escalated && c.status !== 'human' && !c.resolved).length;
  const msgCounts = full.map(c => (c.messages || []).filter(m => m.sender === 'customer').length);
  const avgMsgs   = msgCounts.length ? (msgCounts.reduce((a, b) => a + b, 0) / msgCounts.length).toFixed(1) : 0;
  const whatsapp  = full.filter(c => (c.twilioNumber || '').startsWith('+1415')).length;
  const sms       = full.length - whatsapp;

  console.log('\n## STATS');
  console.log(`Total conversations : ${full.length}  (${whatsapp} WhatsApp, ${sms} SMS)`);
  console.log(`Resolved            : ${resolved}`);
  console.log(`Escalated           : ${escalated}`);
  console.log(`Ian handling        : ${humanMode}`);
  console.log(`Open (bot)          : ${botOnly}`);
  console.log(`Avg customer msgs   : ${avgMsgs} per conversation`);
}

main().catch(err => { console.error(err); process.exit(1); });
