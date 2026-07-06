const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./retry');
const { computeCost } = require('./billing');
const { recordUsage } = require('./store');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000 });

async function askClaude(messages, systemPrompt, model = 'claude-sonnet-4-6') {
  const response = await withRetry(() => client.messages.create({
    model,
    max_tokens: 500,
    system:     systemPrompt,
    messages,
  }));

  const { input_tokens, output_tokens } = response.usage;
  const cost = computeCost(model, input_tokens, output_tokens);
  recordUsage(model, input_tokens, output_tokens, cost).catch(err => console.error('recordUsage failed:', err));

  return response.content[0].text;
}

module.exports = { askClaude };
