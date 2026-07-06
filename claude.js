const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./retry');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000 });

async function askClaude(messages, systemPrompt) {
  const response = await withRetry(() => client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    system:     systemPrompt,
    messages,
  }));

  return response.content[0].text;
}

module.exports = { askClaude };
