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
```

## Security notes

- `.env`, `.env.yaml`, and other local secrets are gitignored — never commit
  real credentials.
- All `/inbox`-facing API routes require the `x-inbox-token` header to match
  `INBOX_SECRET`.
