# Moving CH Autoworks to WhatsApp Business API

## What we're doing and why

Right now the AI bot works but only on a test number. We want to move it to **Ian's actual work WhatsApp number** so real customers get instant replies automatically.

When a customer messages Ian's number, the AI handles it — answers questions, takes booking details, gives prices. If it can't help or something needs Ian's attention, it alerts Ian and he can take over.

---

## How it will work

**Customer messages Ian's number on WhatsApp**
→ AI replies instantly (day or night)
→ If needed, Ian gets a notification on his phone
→ Ian logs into a simple web inbox and replies from there
→ AI hands back after Ian is done

Ian's number stays the same. Customers won't notice any difference — they just get faster replies.

---

## What changes for Ian

- Ian's WhatsApp Business App on his work number will stop working
- Instead, he manages business messages through a simple web inbox (already built)
- His personal WhatsApp (if on a different number) is completely unaffected
- The AI handles routine stuff — Ian only needs to step in when flagged

---

## What we need from Ian

1. **His Facebook login details** (the account linked to the CH Autoworks page)
2. **His work phone** nearby for a one-time verification code (6-digit text, takes 30 seconds)
3. **30 minutes** to complete the setup together

---

## The setup process

1. Log into Twilio (our messaging platform) and start the WhatsApp setup
2. Sign in with Ian's Facebook account — the CH Autoworks page is already there, just select it
3. Enter Ian's work number
4. Ian receives a 6-digit code on his phone — enter it
5. Submit "CH Autoworks" as the display name — Meta approves this within 1–3 days
6. We update the code and go live

---

## Downtime

**Under 30 minutes.** We'll do this on a quiet evening or Sunday. The moment Meta confirms the number is active, we deploy and Ian's number is back online — now with the AI handling it.

During the 1–3 day display name approval, everything still works — messages go in and out normally, the name just shows as a number rather than "CH Autoworks" until approved.

---

## Cost

| What | Cost |
|------|------|
| Setting this up | Free |
| Customers messaging in | Free |
| AI replies to customers | ~£1–2/week at typical volume |
| Ian's number / WhatsApp access | Free |

The only ongoing cost is a fraction of a penny per message through Twilio. At a typical garage volume this is a few pounds a month at most.

---

## Questions Ian might ask

**"Will my customers notice anything?"**
No — same number, same WhatsApp. They just get faster replies.

**"What if the AI gets something wrong?"**
It flags anything it's unsure about to Ian directly. Ian can also see every conversation and step in at any time.

**"Can I still reply to customers myself?"**
Yes — through the web inbox. Ian can take over any conversation whenever he wants.

**"What happens out of hours?"**
The AI is always on. It takes messages, answers questions, and notes booking requests. Ian sees a summary when he's next in.
