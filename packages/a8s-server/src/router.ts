// ============================================================
// @berry-agent/a8s-server — Route abstraction
// ============================================================
//
// Tiny router on top of Node's http module. Lets us split the 900-line
// `server.ts` dispatcher into per-concern modules without pulling in
// Express/Fastify/Hono. The router knows:
//
//   - method + path pattern matching
//   - middleware chain (auth, rate limit, timeout, metrics)
//   - error normalisation (handlers throw, framework serialises)
//
// Path patterns use the same flavour as Express: `/v1/agents/:id` →
// captures `id`. Patterns with `?` suffix on the trailing segment match
// query strings transparently (we strip them before matching).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorPayloadSchema, type ErrorPayload } from '@berry-agent/cluster-protocol';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path params extracted from the route pattern (e.g. `id` from `/v1/agents/:id`). */
  params: Record<string, string>;
  /** Decoded URL search params for read-only inspection. */
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export type Middleware = (ctx: RouteContext, next: () => Promise<void>) => Promise<void>;

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path pattern, e.g. `/v1/agents/:id` or `/v1/operator/workers`. */
  pattern: string;
  handler: RouteHandler;
  /** Route-scoped middleware (run after globals). Use for per-route timeouts, etc. */
  middleware?: Middleware[];
  /** Stable name for metrics / audit. Defaults to `${method} ${pattern}`. */
  name?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function httpError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

interface CompiledRoute extends RouteDefinition {
  matcher: { regex: RegExp; paramNames: string[] };
}

export class Router {
  private readonly routes: CompiledRoute[] = [];
  private readonly globals: Middleware[] = [];

  /** Add a middleware that wraps EVERY route (after the path match succeeds). */
  use(mw: Middleware): this {
    this.globals.push(mw);
    return this;
  }

  add(def: RouteDefinition): this {
    this.routes.push({ ...def, matcher: compilePattern(def.pattern) });
    return this;
  }

  /** Convenience helpers. */
  get(pattern: string, handler: RouteHandler, mw?: Middleware[], name?: string): this {
    return this.add({ method: 'GET', pattern, handler, middleware: mw, name });
  }
  post(pattern: string, handler: RouteHandler, mw?: Middleware[], name?: string): this {
    return this.add({ method: 'POST', pattern, handler, middleware: mw, name });
  }
  delete(pattern: string, handler: RouteHandler, mw?: Middleware[], name?: string): this {
    return this.add({ method: 'DELETE', pattern, handler, middleware: mw, name });
  }

  /**
   * Dispatch an incoming request. Returns true if a route matched and
   * handled it, false otherwise — caller writes a 404.
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '/';
    const qIdx = url.indexOf('?');
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : '');

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.matcher.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.matcher.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] ?? '');
      });
      const ctx: RouteContext = { req, res, params, query };
      const chain = [...this.globals, ...(route.middleware ?? [])];
      let i = 0;
      const next = async (): Promise<void> => {
        if (i < chain.length) {
          const mw = chain[i++];
          await mw(ctx, next);
        } else {
          await route.handler(ctx);
        }
      };
      try {
        await next();
      } catch (err) {
        await handleRouteError(err, res);
      }
      return true;
    }
    return false;
  }
}

async function handleRouteError(err: unknown, res: ServerResponse): Promise<void> {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    writeError(res, err.status, err.code, err.message);
    return;
  }
  // Zod errors carry a structured `.issues` payload; surface the first.
  const issues = (err as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0];
    writeError(res, 400, 'validation_failed', `${first.path.join('.')}: ${first.message}`);
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  writeError(res, 500, 'internal_error', msg);
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ErrorPayload = errorPayloadSchema.parse({ error: { code, message } });
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexSource = pattern
    .replace(/\//g, '\\/')
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${regexSource}$`), paramNames };
}
