# whatsapp-agent

WhatsApp AI customer service agent for CH Autoworks, powered by Claude. Runs as a
Google Cloud Function (Gen2) that receives inbound WhatsApp messages via Twilio,
replies using Claude, logs conversations to Firestore, and exposes a small web
inbox for human takeover.

## How it works

- **Twilio** delivers inbound WhatsApp messages to the `/` webhook (`index.js`).
- **`handler.js`** builds the conversation context and calls Claude (`claude.js`,
  prompted with `SYSTEM_PROMPT.md`) to generate a reply, which is sent back via
  `twilio.js`.
- **Firestore** (`store.js`) persists conversations, status (`bot` / `human`),
  and resolution state.
- **Web inbox** (`web/`) is a static app served at `/inbox`, letting a human
  view conversations, take over from the bot, and reply directly.
- **`summary.js`** generates daily/inbox summaries; **`push.js`** handles web
  push notifications for new messages.
- **`sheets.js`** integrates with Google Sheets.

## Requirements

- Node.js >= 20
- A Google Cloud project with Cloud Functions (Gen2) enabled
- A Twilio account with WhatsApp sending enabled
- An Anthropic API key

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
```

Environment variables (see `.env.example` / `.env.yaml`):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_WHATSAPP_NUMBER` | Twilio WhatsApp sender number |
| `GOOGLE_SHEET_ID` | Google Sheet used for logging/lookups |
| `GARAGE_NAME` / `GARAGE_PHONE` | Business details used in agent responses |
| `INBOX_SECRET` | Bearer token required on all `/inbox`-facing API routes |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web push keys for inbox notifications |
| `TWILIO_WEBHOOK_URL` | Exact URL Twilio is configured to POST to — must match the Twilio console webhook config exactly, used to verify inbound request signatures |

## Running locally

```bash
npm start
```

This starts the Functions Framework locally with the `whatsappWebhook` entry
point (see `index.js`).

## Deploying

```bash
npm run deploy
```

Deploys to Google Cloud Functions (Gen2) using `.env.yaml` for environment
variables. Firebase config (`firebase.json`, `.firebaserc`) is used for
hosting the static `web/` inbox app.

## Project structure

```
index.js        Express app / Cloud Function entry point
handler.js       Inbound message handling + Claude call orchestration
claude.js        Claude API client
twilio.js        Twilio send helper
store.js         Firestore conversation storage
summary.js       Daily / inbox summaries
push.js          Web push subscriptions
sheets.js        Google Sheets integration
web/             Static inbox web app (served at /inbox)
SYSTEM_PROMPT.md Claude system prompt
security.js      Twilio webhook signature verification
rateLimit.js     Per-phone in-memory rate limiting
retry.js         Retry-with-backoff helper for external API calls
billing.js       Claude API cost calculation + markup for invoicing
```

## Security notes

- `.env`, `.env.yaml`, and other local secrets are gitignored — never commit
  real credentials.
- All `/inbox`-facing API routes require the `x-inbox-token` header to match
  `INBOX_SECRET`, compared using a timing-safe check.
- The inbound Twilio webhook (`/`) verifies the `X-Twilio-Signature` header
  against `TWILIO_WEBHOOK_URL` before processing anything — requests that
  don't come from Twilio are rejected with 403. This matters because the
  Cloud Function URL is visible in this (public) repo's `web/app.js`.
- Inbound messages are capped at 2000 characters and rate-limited per phone
  number (20 messages / 5 minutes) to bound cost exposure from abuse.

## Resilience notes

- **Idempotency**: each inbound message is claimed by its Twilio `MessageSid`
  in Firestore (`processed_messages` collection) before processing, so a
  Twilio retry (e.g. if the function is slow to respond) can't cause a
  duplicate AI reply. Consider adding a Firestore TTL policy on
  `processed_messages.processedAt` so this collection doesn't grow forever.
- **Timeouts + retry**: calls to Claude, Twilio, and Google Sheets have
  timeouts and retry transient failures (429/5xx/network errors) with
  exponential backoff (`retry.js`).
- **Graceful degradation**: if Claude fails even after retries, the customer
  gets a friendly fallback message, the conversation is escalated to Ian
  (status `human`), and a push notification is sent — instead of the
  customer being left with no reply at all.
- **Media messages**: a photo/attachment with no text body gets a
  placeholder acknowledgement reply instead of a silent `400`.

## Monitoring

- `GET /health` is an unauthenticated liveness endpoint, separate from the
  Twilio-signed webhook, for uptime checks to hit.
- A Cloud Monitoring uptime check (`whatsapp-agent health`) pings `/health`
  every 5 minutes from multiple regions.
- Two alert policies (in Cloud Monitoring, project `trans-invention-392414`),
  both emailing `bleasejonathan@gmail.com`:
  - **whatsapp-agent: health check failing** — fires if the uptime check
    fails from more than one region.
  - **whatsapp-agent: execution errors** — fires if the function has more
    than 3 non-`ok` executions (errors/crashes/timeouts) in a 5-minute window.
- View/edit these at https://console.cloud.google.com/monitoring/alerting?project=trans-invention-392414

## Billing

Since this runs on Jonathan's GCP project and Anthropic API key (Ian pays for
Twilio directly), Claude API usage is tracked so Ian can be invoiced for his
share:

- Every Claude API call records its token usage and cost into a
  `usage_monthly` Firestore collection (one doc per calendar month), via
  `store.recordUsage()` — called from `claude.js` after every response.
- `GET /billing-summary?month=YYYY-MM` (auth required, defaults to the
  current month) returns the actual Claude cost, current markup %, and the
  total to invoice:
  ```bash
  curl "https://europe-west2-trans-invention-392414.cloudfunctions.net/whatsapp-agent/billing-summary" \
    -H "x-inbox-token: $INBOX_SECRET"
  ```
- `POST /billing-config` sets the markup percentage applied on top of actual
  cost (currently 0% — pure cost tracking until a rate is agreed):
  ```bash
  curl -X POST ".../whatsapp-agent/billing-config" \
    -H "x-inbox-token: $INBOX_SECRET" -H "content-type: application/json" \
    -d '{"markupPercent": 20}'
  ```
- Pricing is hardcoded per-model in `billing.js` (`PRICING`) — update it if
  the model changes or Anthropic's list pricing changes.
- **Not included**: GCP infrastructure cost (Cloud Functions, Firestore) —
  this is usually negligible at pilot volume, but check the GCP billing
  console directly if you want to fold it in.
- **Monthly email report**: a Cloud Scheduler job (`monthly-billing-report`,
  `0 8 1 * *` Europe/London — the 1st of each month, not the 31st, since not
  every month has one) hits `POST /monthly-billing-report`, which emails the
  previous month's Claude cost summary to `bleasejonathan@gmail.com` via
  Gmail SMTP (`email.js`, requires `GMAIL_USER` / `GMAIL_APP_PASSWORD` — a
  Gmail App Password, not the account password).

## Known follow-ups (not yet done)

These need access to live GCP/Twilio config, so they weren't done automatically:

- Move secrets (`ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `INBOX_SECRET`,
  `VAPID_PRIVATE_KEY`) from plain Cloud Function env vars into Secret Manager.
- Add a Firestore TTL policy on `processed_messages.processedAt`.
- Rotate `INBOX_SECRET` to a long random value (see note below).
- Consider a latency alert and/or a billing budget alert as usage grows.
