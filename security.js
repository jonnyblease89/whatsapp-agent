const twilio = require('twilio');

// Twilio signs each webhook request against the exact URL it was configured to call.
// Reconstructing that URL from request headers is unreliable behind Cloud Functions/Cloud
// Run's proxy layer, so we require it to be configured explicitly and keep it in sync with
// whatever URL is set in the Twilio console.
function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = process.env.TWILIO_WEBHOOK_URL;

  if (!authToken || !webhookUrl) {
    console.error('TWILIO_WEBHOOK_URL / TWILIO_AUTH_TOKEN not configured — refusing inbound webhook');
    return res.status(500).send('Server misconfigured');
  }

  const signature = req.headers['x-twilio-signature'];
  const valid = signature && twilio.validateRequest(authToken, signature, webhookUrl, req.body);

  if (!valid) {
    console.error('Rejected webhook request with invalid or missing Twilio signature');
    return res.status(403).send('Forbidden');
  }

  next();
}

module.exports = { verifyTwilioSignature };
