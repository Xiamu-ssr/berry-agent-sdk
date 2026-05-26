import type { Middleware, MiddlewareContext } from '../agent-runtime-types.js';
import type { ProviderRequest, ProviderResponse } from '../provider-types.js';

export async function applyBeforeApiCall(
  request: ProviderRequest,
  middleware: readonly Middleware[],
  context: MiddlewareContext,
): Promise<ProviderRequest> {
  let next = request;
  for (const item of middleware) {
    if (item.onBeforeApiCall) {
      next = await item.onBeforeApiCall(next, context);
    }
  }
  return next;
}

export async function notifyAfterApiCall(
  request: ProviderRequest,
  response: ProviderResponse,
  middleware: readonly Middleware[],
  context: MiddlewareContext,
): Promise<void> {
  for (const item of middleware) {
    if (item.onAfterApiCall) {
      await item.onAfterApiCall(request, response, context);
    }
  }
}

export async function notifyApiCallError(
  request: ProviderRequest,
  error: unknown,
  middleware: readonly Middleware[],
  context: MiddlewareContext,
): Promise<void> {
  for (const item of middleware) {
    if (item.onApiCallError) {
      try {
        await item.onApiCallError(request, error, context);
      } catch {
        // Observation hooks must not hide the original provider failure.
      }
    }
  }
}
