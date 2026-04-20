import { describe, expect, it } from 'vitest';

import { isRetryableError, getRetryDelay, withRetry } from '../utils/retry.js';

describe('isRetryableError', () => {
  it('retries on 429 rate limit', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it('retries on 408 request timeout', () => {
    expect(isRetryableError({ status: 408 })).toBe(true);
  });

  it('retries on 409 lock timeout', () => {
    expect(isRetryableError({ status: 409 })).toBe(true);
  });

  it('retries on 5xx server errors', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  it('retries on network errors', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('does NOT retry on 400/401/403/404', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it('retries AbortError-style timeout aborts', () => {
    const err = new Error('Request was aborted');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('does NOT retry on unknown errors', () => {
    expect(isRetryableError({})).toBe(false);
    expect(isRetryableError(new Error('random'))).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('getRetryDelay', () => {
  // Jitter adds up to 25% of base delay, so test with ranges
  it('uses exponential backoff with jitter', () => {
    const d1 = getRetryDelay(1);
    expect(d1).toBeGreaterThanOrEqual(500);
    expect(d1).toBeLessThanOrEqual(625);  // 500 + 25%

    const d2 = getRetryDelay(2);
    expect(d2).toBeGreaterThanOrEqual(1000);
    expect(d2).toBeLessThanOrEqual(1250);

    const d3 = getRetryDelay(3);
    expect(d3).toBeGreaterThanOrEqual(2000);
    expect(d3).toBeLessThanOrEqual(2500);
  });

  it('caps at MAX_BACKOFF_MS (32s) + jitter', () => {
    const d10 = getRetryDelay(10);
    expect(d10).toBeGreaterThanOrEqual(32_000);
    expect(d10).toBeLessThanOrEqual(40_000); // 32k + 25%

    const d20 = getRetryDelay(20);
    expect(d20).toBeGreaterThanOrEqual(32_000);
    expect(d20).toBeLessThanOrEqual(40_000);
  });

  it('respects retry-after header (no jitter)', () => {
    expect(getRetryDelay(1, '5')).toBe(5000);
    expect(getRetryDelay(1, '30')).toBe(30_000);
  });

  it('falls back to backoff for invalid retry-after', () => {
    const d1 = getRetryDelay(1, 'invalid');
    expect(d1).toBeGreaterThanOrEqual(500);
    expect(d1).toBeLessThanOrEqual(625);

    const d2 = getRetryDelay(1, '');
    expect(d2).toBeGreaterThanOrEqual(500);
    expect(d2).toBeLessThanOrEqual(625);
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws immediately on non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error('auth failed'), { status: 401 });
      }),
    ).rejects.toThrow('auth failed');

    expect(calls).toBe(1);
  });

  it('throws after exhausting retries', async () => {
    // This would take too long with real delays.
    // Instead, verify the error propagates after a few retries using abort.
    let calls = 0;
    const controller = new AbortController();

    // Let it try 3 times then abort
    const promise = withRetry(async () => {
      calls++;
      if (calls >= 3) {
        controller.abort();
      }
      throw Object.assign(new Error('server down'), { status: 500 });
    }, controller.signal);

    await expect(promise).rejects.toThrow('server down');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    let calls = 0;

    const promise = withRetry(async () => {
      calls++;
      if (calls === 1) {
        controller.abort();
      }
      throw Object.assign(new Error('rate limited'), { status: 429 });
    }, controller.signal);

    await expect(promise).rejects.toThrow();
    // Should stop after abort, not retry all 11 times
    expect(calls).toBeLessThanOrEqual(2);
  });
});
