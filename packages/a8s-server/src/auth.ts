// ============================================================
// @berry-agent/a8s-server — Auth helpers
// ============================================================

import {
  ADMIN_AUTH_HEADER,
  WORKER_AUTH_HEADER,
  parseAdminAuthHeader,
  parseWorkerAuthHeader,
} from '@berry-agent/cluster-protocol';
import type { ServerDeps } from './deps.js';
import { httpError, type Middleware } from './router.js';

/** Length-independent timing-safe compare for short secrets. */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Middleware that requires the request to carry the cluster admin
 * token (Bearer). When the server runs without `--admin-token`, this
 * is a no-op (dev mode).
 */
export function requireAdminToken(deps: ServerDeps): Middleware {
  return async (ctx, next) => {
    if (!deps.adminToken) return next(); // dev mode
    const presented = parseAdminAuthHeader(
      ctx.req.headers[ADMIN_AUTH_HEADER.toLowerCase()] as string | undefined,
    );
    if (!presented || !constantTimeEqual(presented, deps.adminToken)) {
      throw httpError(401, 'unauthorized', 'missing or invalid admin token');
    }
    return next();
  };
}

/**
 * Middleware that requires the per-machine token issued at registration.
 * Reads machineId from ctx.params.machineId. Symmetric to
 * requireWorkerToken but backed by the MachineRegistry.
 */
export function requireMachineToken(deps: ServerDeps): Middleware {
  return async (ctx, next) => {
    const machineId = ctx.params.machineId;
    if (!machineId) throw httpError(400, 'invalid_request', 'machineId param missing');
    const presented = parseWorkerAuthHeader(
      ctx.req.headers[WORKER_AUTH_HEADER.toLowerCase()] as string | undefined,
    );
    if (!deps.machines.verifyToken(machineId, presented)) {
      throw httpError(401, 'unauthorized', `invalid or unknown machine token for ${machineId}`);
    }
    return next();
  };
}

/**
 * Middleware that requires the request to carry the per-worker token
 * issued at registration. Reads workerId from ctx.params.workerId.
 */
export function requireWorkerToken(deps: ServerDeps): Middleware {
  return async (ctx, next) => {
    const workerId = ctx.params.workerId;
    if (!workerId) throw httpError(400, 'invalid_request', 'workerId param missing');
    const expected = deps.tokens.get(workerId);
    if (!expected) {
      throw httpError(404, 'unknown_worker', `worker ${workerId} is not registered`);
    }
    const presented = parseWorkerAuthHeader(
      ctx.req.headers[WORKER_AUTH_HEADER.toLowerCase()] as string | undefined,
    );
    if (presented !== expected.token) {
      throw httpError(401, 'unauthorized', 'invalid worker token');
    }
    return next();
  };
}
