// ============================================================
// Berry Agent SDK — Shared Retry Logic
// ============================================================
// Used by both Anthropic and OpenAI providers.
// Exponential backoff with retry-after header support.

import {
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_BACKOFF_MS,
} from '../constants.js';

/** Classify an error as transient (retryable) or permanent. */
export type ErrorKind = 'transient' | 'permanent';

/** Classify an API error. */
export function classifyError(error: any): ErrorKind {
  if (!error) return 'permanent';
  // Transient: rate limit, timeouts, server errors, network issues
  if (error.status === 429) return 'transient';   // rate limit
  if (error.status === 408) return 'transient';   // request timeout
  if (error.status === 409) return 'transient';   // lock timeout
  if (error.status === 503) return 'transient';   // service unavailable
  if (error.status === 502) return 'transient';   // bad gateway
  if (error.status >= 500) return 'transient';    // other server errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return 'transient';
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') return 'transient';
  if (error.code === 'UND_ERR_CONNECT_TIMEOUT') return 'transient';
  // Provider/client-side timeouts often surface as AbortError (e.g. "Request was aborted").
  // Caller-initiated aborts are still not retried because withRetry checks signal.aborted.
  if (error.name === 'AbortError') return 'transient';
  if (typeof error.message === 'string' && /request was aborted/i.test(error.message)) return 'transient';
  // Permanent: auth errors, bad requests, not found
  if (error.status === 401 || error.status === 403) return 'permanent';
  if (error.status === 404) return 'permanent';
  if (error.status === 400) return 'permanent'; // bad request (except PTL, handled elsewhere)
  return 'permanent';
}

/** Determine whether an API error is transient and should be retried. */
export function isRetryableError(error: any): boolean {
  return classifyError(error) === 'transient';
}

/**
 * Compute delay (ms) for exponential backoff, respecting retry-after header.
 * Adds 25% jitter to prevent thundering herd (same as CC).
 */
export function getRetryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

/**
 * Generic retry wrapper. Calls `operation` up to MAX_RETRIES+1 times.
 * Only retries when `isRetryableError` returns true.
 *
 * @param onRetry Optional callback for logging/observability on each retry.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      if (attempt > MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }

      if (signal?.aborted) {
        throw error;
      }

      const retryAfter = error.headers?.['retry-after'] ?? error.headers?.get?.('retry-after') ?? null;
      const delayMs = getRetryDelay(attempt, retryAfter);
      onRetry?.(attempt, error, delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
