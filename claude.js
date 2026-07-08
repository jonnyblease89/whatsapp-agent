const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./retry');
const { computeCost } = require('./billing');
const { recordUsage } = require('./store');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000 });

async function askClaude(messages, systemPrompt, model = 'claude-sonnet-4-6', { track = true } = {}) {
  // Accept either a plain string (e.g. summary) or { base, customerContext } for prompt caching
  let system;
  if (typeof systemPrompt === 'string') {
    system = systemPrompt;
  } else {
    const { base, customerContext } = systemPrompt;
    system = [
      { type: 'text', text: base, cache_control: { type: 'ephemeral' } },
      ...(customerContext ? [{ type: 'text', text: customerContext }] : []),
    ];
  }

  const response = await withRetry(() => client.messages.create({
    model,
    max_tokens: 500,
    system,
    messages,
  }));

  const {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens     = 0,
  } = response.usage;

  if (track) {
    const cost = computeCost(model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens);
    recordUsage(model, input_tokens, output_tokens, cost).catch(err => console.error('recordUsage failed:', err));
  }

  return response.content[0].text;
}

module.exports = { askClaude };
