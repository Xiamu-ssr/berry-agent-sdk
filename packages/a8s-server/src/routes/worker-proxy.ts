// ============================================================
// Routes: worker-proxy — the one place a8s talks to a worker
// ============================================================
//
// a8s holds no per-agent data-plane state. Every per-agent read/write
// (send, sessions, events, usage drill-down) resolves the owning worker
// and forwards the request with the worker auth header. This module is
// the single kernel for that: resolve → fetch-with-worker-token. Routes
// layer their own status/stream/zod handling on top.

import { WORKER_AUTH_HEADER, workerAuthHeader } from '@berry-agent/cluster-protocol';
import { httpError } from '../router.js';
import type { ServerDeps } from '../deps.js';

/**
 * Resolve the worker that owns `agentId` to its token entry (callbackUrl +
 * token). Throws an HttpError when the agent has no assigned worker, or when
 * the worker's token has gone missing. The one lookup every per-agent proxy
 * starts from.
 */
export function resolveAgentWorker<TEntry>(deps: ServerDeps<TEntry>, agentId: string) {
  const loc = deps.plane.getAgentLocation(agentId);
  if (!loc.workerId) {
    throw httpError(404, 'agent_not_assigned', `agent "${agentId}" has no assigned worker`);
  }
  const entry = deps.tokens.get(loc.workerId);
  if (!entry) {
    throw httpError(500, 'worker_token_missing', `no token for worker ${loc.workerId}`);
  }
  return entry;
}

/**
 * Resolve the agent's owning worker and issue a fetch to `subpath` on its
 * callback URL, with the worker auth header merged in. Throws an HttpError
 * (via resolveAgentWorker) when the agent has no assigned worker. Caller owns
 * status/body handling — this only adds the auth header and the base URL.
 */
export async function workerFetch<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  subpath: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  const entry = resolveAgentWorker(deps, agentId);
  return fetch(`${entry.callbackUrl}${subpath}`, {
    method: init?.method ?? 'GET',
    headers: { [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token), ...init?.headers },
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
}

/**
 * workerFetch + non-2xx → HttpError + parsed JSON body. The common shape for
 * the read-only proxies (sessions list, usage drill-down): forward, fail loud
 * on a bad worker reply, hand the JSON back for the route's own zod schema.
 */
export async function workerGetJson<TEntry>(
  deps: ServerDeps<TEntry>,
  agentId: string,
  subpath: string,
  failureCode = 'worker_request_failed',
): Promise<unknown> {
  const response = await workerFetch(deps, agentId, subpath);
  if (!response.ok) {
    throw httpError(response.status, failureCode, `worker returned ${response.status}`);
  }
  return response.json();
}

/** Append the original request's query string (if any) to a worker subpath. */
export function withQuery(path: string, url: string | undefined): string {
  if (!url) return path;
  const i = url.indexOf('?');
  return i >= 0 ? `${path}${url.slice(i)}` : path;
}
