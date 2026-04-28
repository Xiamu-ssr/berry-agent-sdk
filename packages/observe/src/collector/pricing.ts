// ============================================================
// Berry Agent SDK — Observe: Model Pricing
// ============================================================
//
// Single source of truth for cost calculation:
//   1. `overrides` parameter — caller-provided pricing map (e.g. berry-claw's
//      `manager.pricingOverrides` which contains built-in + OpenRouter prices).
//   2. `MODEL_PRICING` — built-in fallback table (6 common models).
//
// OpenRouter integration is the caller's responsibility: fetch the live price
// list with `fetchOpenRouterPricing()` and merge it into `overrides`.  This
// keeps the SDK layer free of hidden global state and gives the product full
// control over what models are priced and how.

export interface ModelPricing {
  /** Cost per million input tokens (USD) */
  input: number;
  /** Cost per million output tokens (USD) */
  output: number;
  /** Cost per million cache-read tokens (USD) */
  cacheRead?: number;
  /** Cost per million cache-write tokens (USD) */
  cacheWrite?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-20250414': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

export interface CostResult {
  inputCost: number;
  outputCost: number;
  cacheSavings: number;
  totalCost: number;
}

/**
 * Calculate cost for a single LLM call.
 * Pricing unit: per million tokens (USD).
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  overrides?: Record<string, ModelPricing>,
): CostResult {
  const pricing = resolvePricing(model, overrides);

  if (!pricing) {
    return { inputCost: 0, outputCost: 0, cacheSavings: 0, totalCost: 0 };
  }

  const perM = 1_000_000;
  const inputCost = (inputTokens / perM) * pricing.input;
  const outputCost = (outputTokens / perM) * pricing.output;

  // Cache savings: difference between what cache-read tokens would cost at full input price
  // vs. what they actually cost at the cache-read rate.
  const cacheReadCost = pricing.cacheRead != null
    ? (cacheReadTokens / perM) * pricing.cacheRead
    : 0;
  const cacheWriteCost = pricing.cacheWrite != null
    ? (cacheWriteTokens / perM) * pricing.cacheWrite
    : 0;
  const fullPriceForCacheReads = (cacheReadTokens / perM) * pricing.input;
  const cacheSavings = fullPriceForCacheReads - cacheReadCost;

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return { inputCost, outputCost, cacheSavings, totalCost };
}

/**
 * Resolve pricing for a model name.
 * Tries exact match first (case-insensitive), then strips common prefixes,
 * then tries suffix matching.
 */
function resolvePricing(model: string, overrides?: Record<string, ModelPricing>): ModelPricing | undefined {
  const modelLower = model.toLowerCase();

  // Exact match (overrides first, case-insensitive)
  const overridesExact = overrides ? findCaseInsensitive(overrides, model) : undefined;
  if (overridesExact) return overridesExact;
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6")
  const stripped = model.includes('/') ? model.split('/').slice(1).join('/') : null;
  if (stripped) {
    const overridesStripped = overrides ? findCaseInsensitive(overrides, stripped) : undefined;
    if (overridesStripped) return overridesStripped;
    if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];
  }

  // Fuzzy: find first key that starts with the same base name (case-insensitive)
  const baseName = (stripped ?? model).toLowerCase().replace(/[\d.]+$/, '').replace(/-$/, '');
  const allPricing = { ...MODEL_PRICING, ...overrides };
  for (const [key, value] of Object.entries(allPricing)) {
    const keyBase = key.toLowerCase().replace(/[\d.]+$/, '').replace(/-$/, '');
    if (keyBase === baseName) return value;
  }

  return undefined;
}

/** Find a key in a pricing map case-insensitively. */
function findCaseInsensitive(
  map: Record<string, ModelPricing>,
  key: string,
): ModelPricing | undefined {
  const lower = key.toLowerCase();
  // Fast path: exact match first
  if (map[key]) return map[key];
  // Case-insensitive fallback
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Get pricing for a model (built-in + overrides). */
export function getPricing(model: string, overrides?: Record<string, ModelPricing>): ModelPricing | undefined {
  return resolvePricing(model, overrides);
}

export { MODEL_PRICING };
