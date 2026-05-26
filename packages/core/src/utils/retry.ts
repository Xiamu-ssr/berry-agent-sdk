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
export function classifyError(error: unknown): ErrorKind {
  if (!error) return 'permanent';
  const status = errorStatusCode(error);
  const code = errorCode(error);
  const name = errorName(error);
  const message = errorMessage(error);
  // Transient: rate limit, timeouts, server errors, network issues
  if (status === 429) return 'transient';   // rate limit
  if (status === 408) return 'transient';   // request timeout
  if (status === 409) return 'transient';   // lock timeout
  if (status === 503) return 'transient';   // service unavailable
  if (status === 502) return 'transient';   // bad gateway
  if (status !== undefined && status >= 500) return 'transient';    // other server errors
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return 'transient';
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return 'transient';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'transient';
  // Provider/client-side timeouts often surface as AbortError (e.g. "Request was aborted").
  // Caller-initiated aborts are still not retried because withRetry checks signal.aborted.
  if (name === 'AbortError') return 'transient';
  if (/request was aborted/i.test(message)) return 'transient';
  // Permanent: auth errors, bad requests, not found
  if (status === 401 || status === 403) return 'permanent';
  if (status === 404) return 'permanent';
  if (status === 400) return 'permanent'; // bad request (except PTL, handled elsewhere)
  return 'permanent';
}

/** Determine whether an API error is transient and should be retried. */
export function isRetryableError(error: unknown): boolean {
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
    } catch (error) {
      lastError = error;

      if (attempt > MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }

      if (signal?.aborted) {
        throw error;
      }

      const retryAfter = retryAfterHeader(error);
      const delayMs = getRetryDelay(attempt, retryAfter);
      onRetry?.(attempt, error, delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
}

function errorStatusCode(error: unknown): number | undefined {
  const status = errorRecord(error).status;
  return typeof status === 'number' ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = errorRecord(error).code;
  return typeof code === 'string' ? code : undefined;
}

function errorName(error: unknown): string | undefined {
  const name = errorRecord(error).name;
  return typeof name === 'string' ? name : undefined;
}

function errorMessage(error: unknown): string {
  const message = errorRecord(error).message;
  return typeof message === 'string' ? message : String(error);
}

function retryAfterHeader(error: unknown): string | null {
  const headers = errorRecord(error).headers;
  if (!headers || typeof headers !== 'object') return null;
  if ('retry-after' in headers) {
    const value = (headers as Record<string, unknown>)['retry-after'];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get('retry-after');
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}
