// ============================================================
// Provider call — retry + streaming + resolver integration
// ============================================================
// Extracted from agent.ts. Self-contained routine for routing a
// provider request through either the streaming or non-streaming
// path, honoring stream-idle timeouts, bounded retries, and forwarding
// transient errors to the attached ProviderResolver (when any).
//
// Keeps the Agent class free of inline retry plumbing. The helper
// never mutates Agent state directly — instead, `refreshIfNeeded` is
// a callback the Agent passes to let itself re-create its Provider
// when the resolver swapped the ProviderConfig.

import type { AgentEvent } from '../agent-runtime-types.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../provider-types.js';
import { MAX_RETRIES, REQUEST_TIMEOUT_MS } from '../constants.js';
import { getRetryDelay, isRetryableError } from '../utils/retry.js';
import { sleep } from './provider.js';

/** Live-ref dependencies callProvider needs from the Agent. */
export interface ProviderCallDeps {
  /** Latest Provider instance — re-read after refreshIfNeeded() in case of swap. */
  getProvider(): Provider;
  /** Ask the resolver to re-derive config and swap Provider when it changed. */
  refreshIfNeeded(): void;
  /** Forward a provider error to the resolver; never throws. */
  reportError(err: unknown, statusCode?: number): boolean;
}

/**
 * Execute a provider request, preferring streaming when requested and
 * supported. Streaming path includes stream-idle timeout + bounded retry
 * for failures before the first token; non-streaming path reports errors
 * to the resolver then rethrows (agent loop decides what to do).
 */
export async function callProvider(
  deps: ProviderCallDeps,
  request: ProviderRequest,
  stream: boolean,
  emit: (event: AgentEvent) => void,
): Promise<ProviderResponse> {
  deps.refreshIfNeeded();

  const providerNow = deps.getProvider();
  if (stream && providerNow.stream) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      let finalResponse: ProviderResponse | null = null;
      let sawAnyStreamEvent = false;

      // Stream idle timeout: abort if no data received for REQUEST_TIMEOUT_MS.
      // Strong supervision rule: first-token stall counts as an inference failure
      // and may be retried a bounded number of times.
      const idleController = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleController.abort(new Error('Provider stream idle timeout')),
          REQUEST_TIMEOUT_MS,
        );
      };

      // Compose with caller's abort signal
      const composedSignal = request.signal
        ? AbortSignal.any([request.signal, idleController.signal])
        : idleController.signal;

      const streamRequest: ProviderRequest = { ...request, signal: composedSignal };
      const currentProvider = deps.getProvider();

      try {
        resetIdle();
        for await (const event of currentProvider.stream!(streamRequest)) {
          sawAnyStreamEvent = true;
          resetIdle();
          if (event.type === 'text_delta') {
            emit({ type: 'text_delta', text: event.text });
          } else if (event.type === 'thinking_delta') {
            emit({ type: 'thinking_delta', thinking: event.thinking });
          } else if (event.type === 'response') {
            finalResponse = event.response;
          }
        }

        if (!finalResponse) {
          throw new Error('Provider stream ended without a final response');
        }

        return finalResponse;
      } catch (error) {
        lastError = error;

        const callerAborted = !!request.signal?.aborted && !idleController.signal.aborted;
        const timedOutBeforeFirstToken = idleController.signal.aborted && !sawAnyStreamEvent;
        const retryableBeforeFirstToken =
          !sawAnyStreamEvent &&
          !callerAborted &&
          (timedOutBeforeFirstToken || isRetryableError(error));

        let failedOver = false;
        if (!callerAborted) {
          failedOver = deps.reportError(error, errorStatusCode(error));
          // Let the resolver rotate before the next retry attempt.
          deps.refreshIfNeeded();
        }

        if (!retryableBeforeFirstToken && !failedOver) {
          throw error;
        }
        if (attempt > MAX_RETRIES) {
          throw error;
        }

        const retryAfter = retryAfterHeader(error);
        const delayMs = getRetryDelay(attempt, retryAfter);

        // Structured retry event so UIs / observe can surface strong-supervision decisions
        // (e.g. "retrying after first-token timeout 2/4") without parsing error strings.
        emit({
          type: 'retry',
          scope: 'stream',
          attempt,
          maxAttempts: MAX_RETRIES + 1,
          reason: failedOver ? 'transient_error' : timedOutBeforeFirstToken ? 'stream_idle_timeout' : 'transient_error',
          errorMessage: errorMessage(error),
          delayMs,
        });

        await sleep(delayMs, request.signal);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    }

    throw lastError;
  }

  try {
    return await providerNow.chat(request);
  } catch (error) {
    const statusCode = errorStatusCode(error);
    const callerAborted = !!request.signal?.aborted;
    if (!callerAborted && deps.reportError(error, statusCode)) {
      deps.refreshIfNeeded();
      return await deps.getProvider().chat(request);
    }
    throw error;
  }
}

function errorStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
}

function retryAfterHeader(error: unknown): string | null | undefined {
  if (!error || typeof error !== 'object' || !('headers' in error)) return null;
  const headers = error.headers;
  if (headers && typeof headers === 'object') {
    if ('retry-after' in headers) {
      const value = headers['retry-after' as keyof typeof headers];
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
    }
    if ('get' in headers && typeof headers.get === 'function') {
      const value = headers.get('retry-after');
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(value);
      if (value === null) return value;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}
