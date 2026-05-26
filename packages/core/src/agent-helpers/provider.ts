// ============================================================
// Agent helpers — provider utilities
// ============================================================
// Small, pure functions used by Agent to construct / compare
// providers and classify provider errors. Extracted so that
// agent.ts can stay focused on orchestration.

import type {
  Provider,
  ProviderConfig,
  ProviderInput,
  ProviderResolver,
} from '../provider-types.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';

/**
 * Abortable sleep used by retry backoff. Resolves after `ms` or rejects
 * immediately when `signal` aborts.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Aborted during retry backoff'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(signal.reason ?? new Error('Aborted during retry backoff'));
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

export function isProviderResolver(input: ProviderInput): input is ProviderResolver {
  return typeof (input as ProviderResolver).resolve === 'function';
}

export function providerConfigsEqual(a: ProviderConfig, b: ProviderConfig): boolean {
  return (
    a.type === b.type &&
    a.apiKey === b.apiKey &&
    a.model === b.model &&
    (a.baseUrl ?? '') === (b.baseUrl ?? '')
  );
}

/**
 * Detect "prompt too long" errors from various providers.
 *
 * Anthropic: status 400, error.type = 'invalid_request_error',
 *   message contains 'prompt is too long' or 'too many tokens'
 * OpenAI: status 400, code = 'context_length_exceeded'
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  // Anthropic SDK: BadRequestError with message about prompt length
  const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase();
  if (
    msg.includes('prompt is too long') ||
    msg.includes('too many tokens') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length')
  ) {
    return true;
  }

  // OpenAI SDK: error.code === 'context_length_exceeded'
  if (e.code === 'context_length_exceeded') return true;
  const nested = e.error;
  if (nested && typeof nested === 'object' && (nested as Record<string, unknown>).code === 'context_length_exceeded') return true;

  return false;
}

/**
 * Best-effort extraction of the provider-reported context window from prompt
 * length errors. Providers phrase this differently ("250000 > 100000
 * maximum", "maximum context length is 128000 tokens", etc.), so keep this
 * intentionally conservative and return only plausible token limits.
 */
export function extractContextWindowFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const msg = typeof e.message === 'string' ? e.message : '';
  const nested = e.error && typeof e.error === 'object'
    ? String((e.error as Record<string, unknown>).message ?? '')
    : '';
  const text = `${msg}\n${nested}`;

  const patterns = [
    /(?:supports\s+at\s+most|at\s+most)\D{0,32}([\d,]{4,})/i,
    /(?:maximum context length|max(?:imum)?(?: context)?(?: length)?|context(?: length)? limit)\D{0,32}([\d,]{4,})/i,
    />\s*([\d,]{4,})\s*(?:tokens?)?\s*(?:maximum|max|limit)/i,
    /([\d,]{4,})\s*(?:tokens?)?\s*(?:maximum|max|context limit)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match?.[1] ? Number(match[1].replace(/,/g, '')) : NaN;
    if (Number.isFinite(parsed) && parsed >= 4_000 && parsed <= 10_000_000) {
      return parsed;
    }
  }
  return undefined;
}
