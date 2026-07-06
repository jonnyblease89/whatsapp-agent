const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function askClaude(messages, systemPrompt) {
  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    system:     systemPrompt,
    messages,
  });

  return response.content[0].text;
}

module.exports = { askClaude };
