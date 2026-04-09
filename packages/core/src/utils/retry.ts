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

/** Determine whether an API error is transient and should be retried. */
export function isRetryableError(error: any): boolean {
  if (error?.status === 429) return true;   // rate limit
  if (error?.status === 408) return true;   // request timeout
  if (error?.status === 409) return true;   // lock timeout
  if (error?.status >= 500) return true;    // server errors
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') return true;
  return false;
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
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
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

      const retryAfter = error.headers?.['retry-after'] ?? null;
      const delayMs = getRetryDelay(attempt, retryAfter);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
