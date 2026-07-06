// USD per 1M tokens. Update when switching models or on a pricing change.
const PRICING = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
};

function computeCost(model, inputTokens, outputTokens) {
  const rates = PRICING[model];
  if (!rates) return 0;
  return (inputTokens / 1e6) * rates.input + (outputTokens / 1e6) * rates.output;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildBillingSummary(month, usage, markupPercent) {
  const claudeCostUSD = usage?.totalCostUSD || 0;
  const markupUSD = claudeCostUSD * (markupPercent / 100);

  return {
    month,
    markupPercent,
    claudeCostUSD: round2(claudeCostUSD),
    markupUSD: round2(markupUSD),
    totalUSD: round2(claudeCostUSD + markupUSD),
    models: usage?.models || {},
    note: 'GCP infra costs (Cloud Functions, Firestore) are not included here — check the GCP billing console directly.',
  };
}

function previousMonth() {
  const now = new Date();
  const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function formatBillingEmail(summary) {
  const modelLines = Object.entries(summary.models).map(([model, m]) =>
    `  ${model}: ${m.requestCount} requests, ${m.inputTokens} in / ${m.outputTokens} out tokens, $${round2(m.costUSD)}`
  ).join('\n') || '  (no usage recorded)';

  return `whatsapp-agent — billing summary for ${summary.month}

Claude API cost: $${summary.claudeCostUSD}
Markup (${summary.markupPercent}%): $${summary.markupUSD}
Total to invoice: $${summary.totalUSD}

By model:
${modelLines}

${summary.note}
GCP billing console: https://console.cloud.google.com/billing/0105C4-D7C7E5-AEE86A/reports?project=trans-invention-392414`;
}

module.exports = { computeCost, buildBillingSummary, previousMonth, formatBillingEmail, PRICING };
