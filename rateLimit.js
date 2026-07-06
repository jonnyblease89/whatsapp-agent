// Simple in-memory sliding-window limiter, keyed per phone number.
// Best-effort only: resets on cold start and isn't shared across concurrent instances.
// It exists to cap the cost/abuse blast radius from a single number, not as a hard guarantee.

const WINDOW_MS      = 5 * 60 * 1000;
const MAX_PER_WINDOW = 20;

const hits = new Map(); // phone -> timestamps[]

function isRateLimited(phone) {
  const now  = Date.now();
  const list = (hits.get(phone) || []).filter(ts => now - ts < WINDOW_MS);

  if (list.length >= MAX_PER_WINDOW) {
    hits.set(phone, list);
    return true;
  }

  list.push(now);
  hits.set(phone, list);
  return false;
}

module.exports = { isRateLimited };
