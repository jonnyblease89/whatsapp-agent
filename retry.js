// Retries transient failures (network errors, timeouts, 429/5xx) with exponential backoff.
// Non-transient errors (4xx other than 429) fail fast since retrying won't help.
async function withRetry(fn, { retries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
