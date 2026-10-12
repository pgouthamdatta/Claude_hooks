'use strict';

// Per-million-token USD list pricing. Update this table when Anthropic
// publishes new rates (https://platform.claude.com/docs/en/pricing) — this
// tool never fetches pricing dynamically.
//
// Cached 2026-06-24 via the claude-api skill.
const PRICING = {
  'claude-sonnet-5': { input: 3.00, output: 15.00 },
  'claude-opus-5': { input: 5.00, output: 25.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
};

// Cache pricing isn't a separate published rate — it's a multiplier of the
// model's own input price. Cache write assumes the default 5-minute TTL
// (the transcript doesn't record which TTL was actually requested for a
// given write, so 1-hour-TTL writes will be slightly underpriced here).
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * @param {{input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number}} usage
 * @param {string} model
 * @returns {{inputCost: number, outputCost: number, cacheReadCost: number, cacheWriteCost: number, totalCost: number} | null}
 *   null when the model isn't in PRICING — caller decides whether to warn/skip.
 */
function calculateCost(usage, model) {
  const rates = PRICING[model];
  if (!rates) return null;

  const inputCost = ((usage.input_tokens || 0) * rates.input) / 1e6;
  const outputCost = ((usage.output_tokens || 0) * rates.output) / 1e6;
  const cacheReadCost =
    ((usage.cache_read_input_tokens || 0) * rates.input * CACHE_READ_MULTIPLIER) / 1e6;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens || 0) * rates.input * CACHE_WRITE_MULTIPLIER) / 1e6;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}

module.exports = { PRICING, calculateCost };
