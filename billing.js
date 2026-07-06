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

module.exports = { computeCost, buildBillingSummary, PRICING };
