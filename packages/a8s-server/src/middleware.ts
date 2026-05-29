// ============================================================
// @berry-agent/a8s-server — Middleware
// ============================================================
//
// Composable middleware functions for the Router. Each returns a
// `Middleware` (ctx, next → Promise<void>) so they can be chained at
// either global or per-route level.

import { performance } from 'node:perf_hooks';
import { httpError, type Middleware, type RouteContext } from './router.js';
import type { A8sMetrics } from './metrics.js';
import type { AuditLog, AuditEntry } from './audit.js';

// ============================================================
// Metrics middleware
// ============================================================
// Records request count + duration per route. Reads route metadata
// from ctx (caller stamps `(ctx as any).__routeName`); falls back to
// `${method} ${path}` if absent.

export function withMetrics(metrics: A8sMetrics, routeName: string): Middleware {
  return async (ctx, next) => {
    const start = performance.now();
    let status = 200;
    try {
      await next();
      status = ctx.res.statusCode || 200;
    } catch (err) {
      status = err && typeof err === 'object' && 'status' in err
        ? (err as { status: number }).status
        : 500;
      throw err;
    } finally {
      const duration = (performance.now() - start) / 1000;
      metrics.requestsTotal.inc({ route: routeName, status: String(status) });
      metrics.requestDurationSeconds.observe(duration, { route: routeName });
    }
  };
}

// ============================================================
// Timeout middleware
// ============================================================
// Aborts the handler after `ms` if it hasn't responded. Useful for
// list/get endpoints that should never sit; do NOT apply to long-poll
// or streaming routes (send, events/stream).

export function withTimeout(ms: number): Middleware {
  return async (ctx, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(httpError(504, 'request_timeout', `handler exceeded ${ms}ms`)),
        ms,
      );
    });
    try {
      await Promise.race([next(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// ============================================================
// Audit middleware
// ============================================================
// Records the action regardless of outcome. Caller declares the action
// + how to extract the target from the request. The actor is derived
// from the admin token presence (we don't carry per-user identity yet).

export interface AuditMiddlewareOptions {
  action: string;
  /** Pull target identifier from the request (e.g. agentId from params). */
  target?: (ctx: RouteContext) => string | undefined;
  /** Free-form details to record. Called after the handler runs. */
  details?: (ctx: RouteContext) => Record<string, unknown> | undefined;
}

export function withAudit(log: AuditLog, options: AuditMiddlewareOptions): Middleware {
  return async (ctx, next) => {
    let outcome: 'ok' | 'err' = 'ok';
    try {
      await next();
      if (ctx.res.statusCode >= 400) outcome = 'err';
    } catch (err) {
      outcome = 'err';
      throw err;
    } finally {
      const entry: AuditEntry = {
        ts: Date.now(),
        action: options.action,
        actor: 'admin-token',
        sourceIp: extractSourceIp(ctx),
        target: options.target?.(ctx),
        outcome,
        details: options.details?.(ctx),
      };
      // Fire-and-forget; AuditLog.log swallows errors internally.
      void log.log(entry);
    }
  };
}

function extractSourceIp(ctx: RouteContext): string | undefined {
  const fwd = ctx.req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0].split(',')[0].trim();
  return ctx.req.socket.remoteAddress ?? undefined;
}

// ============================================================
// Rate limit (token bucket)
// ============================================================
// Per source-IP bucket, refilled at `refillPerSecond` up to `capacity`.
// Trades simplicity for accuracy; sufficient for "stop a single client
// from hammering the operator API". For a real DDoS surface, put
// nginx in front.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitOptions {
  capacity: number;
  refillPerSecond: number;
  /** Optional override for the key extracted from the request. Defaults to source IP. */
  keyFn?: (ctx: RouteContext) => string;
}

export function withRateLimit(options: RateLimitOptions): Middleware {
  const buckets = new Map<string, Bucket>();
  const keyFn = options.keyFn ?? ((ctx) => extractSourceIp(ctx) ?? 'unknown');

  return async (ctx, next) => {
    const key = keyFn(ctx);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: options.capacity, lastRefill: now };
      buckets.set(key, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      throw httpError(429, 'rate_limited', `rate limit exceeded for ${key}`);
    }
    bucket.tokens -= 1;
    await next();
  };
}
