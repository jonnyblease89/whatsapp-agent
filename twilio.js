const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendMessage(from, to, body) {
  await client.messages.create({ from, to, body });
}

module.exports = { sendMessage };
