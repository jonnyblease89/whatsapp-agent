const twilio = require('twilio');
const { withRetry } = require('./retry');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, {
  timeout: 15_000,
});

async function sendMessage(from, to, body) {
  await withRetry(() => client.messages.create({ from, to, body }));
}

module.exports = { sendMessage };
