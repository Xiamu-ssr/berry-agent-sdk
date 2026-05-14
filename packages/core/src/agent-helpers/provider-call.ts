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

import type {
  AgentEvent,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../types.js';
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
  reportError(err: unknown, statusCode?: number): void;
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
      } catch (error: any) {
        lastError = error;

        const callerAborted = !!request.signal?.aborted && !idleController.signal.aborted;
        const timedOutBeforeFirstToken = idleController.signal.aborted && !sawAnyStreamEvent;
        const retryableBeforeFirstToken =
          !sawAnyStreamEvent &&
          !callerAborted &&
          (timedOutBeforeFirstToken || isRetryableError(error));

        if (!callerAborted) {
          deps.reportError(error, typeof error?.status === 'number' ? error.status : undefined);
          // Let the resolver rotate before the next retry attempt.
          deps.refreshIfNeeded();
        }

        if (!retryableBeforeFirstToken || attempt > MAX_RETRIES) {
          throw error;
        }

        const retryAfter =
          error.headers?.['retry-after'] ?? error.headers?.get?.('retry-after') ?? null;
        const delayMs = getRetryDelay(attempt, retryAfter);

        // Structured retry event so UIs / observe can surface strong-supervision decisions
        // (e.g. "retrying after first-token timeout 2/4") without parsing error strings.
        emit({
          type: 'retry',
          scope: 'stream',
          attempt,
          maxAttempts: MAX_RETRIES + 1,
          reason: timedOutBeforeFirstToken ? 'stream_idle_timeout' : 'transient_error',
          errorMessage: typeof error?.message === 'string' ? error.message : String(error),
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
  } catch (error: any) {
    const statusCode = typeof error?.status === 'number' ? error.status : undefined;
    const callerAborted = !!request.signal?.aborted;
    if (!callerAborted) {
      deps.reportError(error, statusCode);
    }
    throw error;
  }
}
