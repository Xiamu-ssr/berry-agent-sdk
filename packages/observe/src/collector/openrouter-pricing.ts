// ============================================================
// Berry Agent SDK — Observe: OpenRouter Pricing Fetcher
// ============================================================
// Pure utility: fetches live model pricing from OpenRouter and normalises
// it into the SDK's per-million-tokens unit.
//
// There is NO caching here.  The caller (e.g. berry-claw) decides where
// and how to store the result.  In berry-claw the result is merged into
// `manager.pricingOverrides` which is the single source of truth for
// cost calculation.
//
// OpenRouter pricing unit: per token (e.g. 0.00000174 USD / token)
// SDK pricing unit:        per million tokens (e.g. 1.74 USD / M tokens)

import type { ModelPricing } from './pricing.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';
const PER_MILLION = 1_000_000;

interface OpenRouterModel {
  id: string;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  context_length?: number;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

/** Convert per-token string price to per-million number. */
function toPerMillion(priceStr: string | undefined): number | undefined {
  if (priceStr == null || priceStr === '') return undefined;
  const n = Number(priceStr);
  return Number.isFinite(n) ? n * PER_MILLION : undefined;
}

/** Build a normalised pricing map from an OpenRouter API response. */
function normalisePricing(data: OpenRouterModel[]): Record<string, ModelPricing> {
  const map: Record<string, ModelPricing> = {};
  for (const m of data) {
    const input = toPerMillion(m.pricing.prompt);
    const output = toPerMillion(m.pricing.completion);
    if (input == null || output == null) continue;

    const pricing: ModelPricing = {
      input,
      output,
      cacheRead: toPerMillion(m.pricing.input_cache_read),
      cacheWrite: toPerMillion(m.pricing.input_cache_write),
    };

    // Store under the raw OpenRouter id (includes provider prefix)
    map[m.id] = pricing;

    // Also store under the stripped id (without provider prefix) so that
    // resolvePricing() can match both forms without extra work.
    const stripped = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : null;
    if (stripped && !map[stripped]) {
      map[stripped] = pricing;
    }
  }
  return map;
}

/**
 * Fetch fresh pricing from OpenRouter.  Network errors are swallowed and
 * return an empty map so that the SDK never crashes because of a flaky
 * pricing endpoint.
 *
 * The caller owns the result — merge it into your pricingOverrides and
 * pass that to `createCollector()` / `createObserver()` / `calculateCost()`.
 */
export async function fetchOpenRouterPricing(): Promise<Record<string, ModelPricing>> {
  try {
    const res = await fetch(OPENROUTER_API_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[OpenRouter pricing] HTTP ${res.status}: ${res.statusText}`);
      return {};
    }
    const json = (await res.json()) as OpenRouterResponse;
    if (!Array.isArray(json.data)) {
      console.warn('[OpenRouter pricing] Unexpected response shape');
      return {};
    }
    return normalisePricing(json.data);
  } catch (err) {
    console.warn('[OpenRouter pricing] Fetch failed:', (err as Error).message);
    return {};
  }
}
