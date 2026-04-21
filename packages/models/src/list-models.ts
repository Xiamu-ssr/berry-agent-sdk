// ============================================================
// @berry-agent/models — listModels(): dynamic model catalog
// ============================================================
// Best-effort fetch of a provider's current model list. Falls back to
// the preset's `knownModels` when the provider doesn't expose an endpoint
// or the call fails (auth, network, schema drift).

import type { ProviderPreset, ProviderInstance } from './types.js';
import { getPreset, RAW_PRESET_ID } from './presets.js';

export interface ListModelsOptions {
  /** Override preset's listModelsPath. */
  listPath?: string;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Custom fetch impl (test / node-fetch / undici). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ListModelsResult {
  /** Sorted, deduped model ids. */
  models: string[];
  /** Where the list came from — lets the UI show "Live" vs "Cached". */
  source: 'live' | 'known';
  /** Non-fatal error message when live fetch failed and we fell back. */
  warning?: string;
}

/**
 * List available models for a provider instance. Handles built-in presets and
 * raw providers uniformly: if a listModelsPath is available, it calls it; if
 * not, it returns the preset's `knownModels` (or the instance's own
 * `knownModels` when the provider is raw).
 */
export async function listModels(
  instance: ProviderInstance,
  presetOrOptions?: ProviderPreset | ListModelsOptions,
  maybeOptions: ListModelsOptions = {},
): Promise<ListModelsResult> {
  let preset: ProviderPreset | undefined;
  let options: ListModelsOptions;
  if (presetOrOptions && 'id' in presetOrOptions) {
    preset = presetOrOptions;
    options = maybeOptions;
  } else {
    preset = getPreset(instance.presetId);
    options = (presetOrOptions as ListModelsOptions | undefined) ?? {};
  }

  // Raw / unknown preset: rely on the instance's own declaration only.
  if (instance.presetId === RAW_PRESET_ID || !preset) {
    const fallback = instance.knownModels ?? [];
    return { models: sortUnique(fallback), source: 'known' };
  }

  const listPath = options.listPath ?? preset.listModelsPath;
  if (!listPath) {
    // Provider has no public catalog endpoint — fall back to the preset's list.
    return { models: sortUnique(preset.knownModels), source: 'known' };
  }

  const baseUrl = instance.baseUrl ?? preset.baseUrl;
  const url = joinUrl(baseUrl, listPath);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('listModels timeout')), timeoutMs);

  try {
    const resp = await doFetch(url, {
      headers: authHeaders(preset, instance.apiKey),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return {
        models: sortUnique(preset.knownModels),
        source: 'known',
        warning: `listModels ${resp.status}: fell back to cached list`,
      };
    }

    const body = (await resp.json()) as unknown;
    const ids = extractModelIds(body);
    if (ids.length === 0) {
      return {
        models: sortUnique(preset.knownModels),
        source: 'known',
        warning: 'listModels returned no ids: fell back to cached list',
      };
    }
    return { models: sortUnique(ids), source: 'live' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      models: sortUnique(preset.knownModels),
      source: 'known',
      warning: `listModels error (${msg}): fell back to cached list`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(preset: ProviderPreset, apiKey: string): Record<string, string> {
  if (preset.type === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  // openai-compatible
  return { Authorization: `Bearer ${apiKey}` };
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * Extract model ids from an unknown response body. Handles the common shapes:
 *   - { data: [{ id: string, ... }, ...] }     (OpenAI / OpenRouter)
 *   - { models: [{ id: string, ... }, ...] }   (Anthropic / others)
 *   - [{ id: string }, ...]                    (bare array)
 */
function extractModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const anyBody = body as Record<string, unknown>;

  const candidates = [
    anyBody.data,
    anyBody.models,
    Array.isArray(body) ? body : undefined,
  ].filter(Array.isArray) as unknown[][];

  for (const arr of candidates) {
    const ids = arr
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'id' in item && typeof (item as any).id === 'string') {
          return (item as any).id as string;
        }
        return null;
      })
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length > 0) return ids;
  }
  return [];
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
