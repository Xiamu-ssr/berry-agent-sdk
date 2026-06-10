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
import { httpError, type Middleware, type RouteContext } from './router.js';

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
 * Middleware for product-facing resource routes (agents/sessions/skills/…).
 * Resolves the caller's scope onto `ctx.scope`:
 *   - admin token  → '*'  (cluster operator, sees everything)
 *   - product token → { product }  (sees only its own resources)
 *   - otherwise     → 401
 *
 * Dev mode (no admin token configured AND no product credentials issued) is a
 * no-op that grants operator scope, mirroring requireAdminToken's dev bypass.
 * Operator-only routes keep using requireAdminToken instead of this.
 */
export function requireProductScope(deps: ServerDeps): Middleware {
  return async (ctx, next) => {
    const presented = parseAdminAuthHeader(
      ctx.req.headers[ADMIN_AUTH_HEADER.toLowerCase()] as string | undefined,
    );
    // Admin token → operator scope.
    if (deps.adminToken && presented && constantTimeEqual(presented, deps.adminToken)) {
      ctx.scope = '*';
      return next();
    }
    // Product token → product scope (root) or product:subject scope (scoped).
    const resolved = deps.productCredentials.verify(presented);
    if (resolved) {
      ctx.scope = resolved.subject !== undefined
        ? { product: resolved.product, subject: resolved.subject }
        : { product: resolved.product };
      return next();
    }
    // Dev bypass: no admin token AND no products issued → open operator scope.
    if (!deps.adminToken && deps.productCredentials.list().length === 0) {
      ctx.scope = '*';
      return next();
    }
    throw httpError(401, 'unauthorized', 'missing or invalid token');
  };
}

/**
 * True when the scope may access a resource owned by `owner`.
 *   - operator (`'*'`)             → everything
 *   - root token (`{product}`)     → owner is exactly the product, OR any
 *                                    `product:subject` under it (a product
 *                                    backend sees all its users' resources)
 *   - scoped token (`{p, subject}`) → owner is exactly `product:subject`
 * An undefined owner (legacy/unowned) is operator-only.
 */
export function scopeCanAccess(scope: RouteContext['scope'], owner: string | undefined): boolean {
  if (scope === '*') return true;
  if (!scope || owner === undefined) return false;
  if (scope.subject !== undefined) {
    return owner === `${scope.product}:${scope.subject}`;
  }
  return owner === scope.product || owner.startsWith(`${scope.product}:`);
}

/**
 * Middleware for per-agent routes (`/v1/agents/:agentId/...`): resolve scope
 * (like requireProductScope), then verify the scope may access THIS agent by
 * its owner. A product cannot drive another product's agent — it gets a 404
 * (not 403, to avoid leaking existence across products). Operator sees all.
 */
export function requireAgentScope(deps: ServerDeps): Middleware {
  const scopeGate = requireProductScope(deps);
  return async (ctx, next) => {
    await scopeGate(ctx, async () => {
      const agentId = ctx.params.agentId;
      if (!agentId) throw httpError(400, 'invalid_request', 'agentId param missing');
      const owner = deps.plane.getAgentLocation(agentId).owner ?? undefined;
      if (!scopeCanAccess(ctx.scope, owner)) {
        throw httpError(404, 'agent_not_found', `agent "${agentId}" not found`);
      }
      return next();
    });
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
