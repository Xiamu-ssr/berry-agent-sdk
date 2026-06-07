// ============================================================
// @berry-agent/a8s-server — HTTP server
// ============================================================
//
// Composition root. Wires the ControlPlane, audit log, metrics,
// wake scheduler, and route modules into a Router, and runs an
// http.Server on top. Route bodies live in `routes/*` modules.
//
// Lifecycle:
//   1. `start()` — bind, install routes, start wake scheduler.
//   2. `stop()` — graceful drain: stop accepting new connections,
//      wait for in-flight handlers (up to `drainTimeoutMs`), then
//      close the wake scheduler and the HTTP server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  errorPayloadSchema,
  WORKER_AUTH_HEADER,
  WORKER_PATHS,
  workerAuthHeader,
} from '@berry-agent/cluster-protocol';
import {
  ControlPlane,
  type ControlPlaneOptions,
} from '@berry-agent/a8s';
import { ManagedRuntimeWakeScheduler, type RuntimeWake } from '@berry-agent/runtime';

import { AuditLog, NullAuditLog } from './audit.js';
import type { ServerDeps, WorkerTokenEntry } from './deps.js';
import { A8sMetrics } from './metrics.js';
import { withMetrics, withRateLimit } from './middleware.js';
import { ModelsTemplateStore } from './models-template-store.js';
import { MachineRegistry } from './machine-registry.js';
import { HandRecipeStore } from './hand-recipe-store.js';
import { SkillStore } from './skill-store.js';
import { ProductCredentialStore } from './product-credentials.js';
import { Router, type RouteDefinition } from './router.js';
import { writeJson } from './http-helpers.js';

import { agentRoutes } from './routes/agents.js';
import { healthRoutes, uiRoutes } from './routes/health.js';
import { machineRoutes } from './routes/machines.js';
import { handRecipeRoutes } from './routes/hand-recipes.js';
import { skillRegistryRoutes } from './routes/skills.js';
import { productCredentialRoutes } from './routes/product-credentials.js';
import { auditRoutes } from './routes/audit.js';
import { modelsRoutes } from './routes/models.js';
import { operatorRoutes } from './routes/operator.js';
import { sessionRoutes } from './routes/sessions.js';
import { wakeRoutes } from './routes/wakes.js';
import { workerRoutes } from './routes/workers.js';

export interface A8sServerOptions<TEntry = unknown> {
  port: number;
  controlPlane: ControlPlaneOptions<TEntry>;
  /**
   * Shared admin token. When unset a8s runs in INSECURE DEV MODE and
   * all product/operator endpoints accept any caller — fine for tests
   * and laptop dev, never for a real deployment.
   */
  adminToken?: string;
  /**
   * Externally-reachable a8s URL embedded in worker-join scripts.
   * Defaults to `http://localhost:<port>`.
   */
  advertiseUrl?: string;
  /**
   * Directory the audit log writes to. Defaults to a no-op log when
   * unset — fine for tests; set this in production so destructive
   * operator actions get recorded.
   */
  auditRoot?: string;
  /**
   * Wake scheduler tick interval (ms). Set 0 to disable the
   * in-process wake loop. Default 1_000.
   */
  wakeTickMs?: number;
  /**
   * Per-source-IP rate limit applied to non-streaming routes. Tuple of
   * `[capacity, refillPerSecond]`. Default `[120, 20]` — 20 req/s
   * sustained with 120 burst, easily survives a UI page-load + admin
   * agent chatter but stops a runaway client. Pass `null` to disable.
   * Streaming routes (SSE) and the data-plane `send` are exempt — they
   * are long-lived by design and should not be flow-controlled here.
   */
  rateLimit?: [number, number] | null;
  /**
   * Path of the JSON file storing the cluster-wide models template
   * (provider/model/tier config). Workers fetch it at register time so
   * operators configure LLMs once in the UI and every new worker
   * inherits. Default: <auditRoot>/../models-template.json, or
   * `/var/berry/a8s/models-template.json` when auditRoot is unset.
   */
  modelsTemplateFile?: string;
  /**
   * How long `stop()` waits for in-flight requests to finish before
   * closing the listener. Default 10_000 ms.
   */
  drainTimeoutMs?: number;
  version?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class A8sServer<TEntry = unknown> {
  private server: Server | null = null;
  readonly plane: ControlPlane<TEntry>;
  private readonly options: A8sServerOptions<TEntry>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly tokens = new Map<string, WorkerTokenEntry>();
  private readonly startedAt = Date.now();
  private readonly adminToken: string | undefined;
  private readonly audit: AuditLog;
  private readonly metrics = new A8sMetrics();
  private readonly modelsTemplate: ModelsTemplateStore;
  private readonly machines = new MachineRegistry();
  private readonly handRecipes: HandRecipeStore;
  private readonly skills: SkillStore;
  private readonly productCredentials = new ProductCredentialStore();
  private readonly inflight = new Set<Promise<void>>();
  private wakeScheduler: ManagedRuntimeWakeScheduler | null = null;
  private router: Router | null = null;
  private deps: ServerDeps<TEntry> | null = null;

  constructor(options: A8sServerOptions<TEntry>) {
    this.options = options;
    this.plane = new ControlPlane<TEntry>(options.controlPlane);
    this.logger = options.logger ?? console;
    this.adminToken = options.adminToken;
    this.audit = options.auditRoot
      ? new AuditLog({ auditRoot: options.auditRoot, logger: this.logger })
      : new NullAuditLog();
    const modelsTemplateFile = options.modelsTemplateFile
      ?? (options.auditRoot
        ? `${options.auditRoot.replace(/\/audit\/?$/, '')}/models-template.json`
        : '/var/berry/a8s/models-template.json');
    this.modelsTemplate = new ModelsTemplateStore({
      filePath: modelsTemplateFile,
      logger: this.logger,
    });
    const handRecipesFile = options.auditRoot
      ? `${options.auditRoot.replace(/\/audit\/?$/, '')}/hand-recipes.json`
      : '/var/berry/a8s/hand-recipes.json';
    this.handRecipes = new HandRecipeStore({
      filePath: handRecipesFile,
      logger: this.logger,
    });
    const skillsFile = options.auditRoot
      ? `${options.auditRoot.replace(/\/audit\/?$/, '')}/skill-registry.json`
      : '/var/berry/a8s/skill-registry.json';
    this.skills = new SkillStore({
      filePath: skillsFile,
      logger: this.logger,
    });
    if (!this.adminToken) {
      this.logger.warn?.(
        '[a8s-server] WARNING: starting without --admin-token; all product-scope endpoints are open. Use only for dev/tests.',
      );
    }
  }

  /**
   * Test/debug accessor — returns the bearer token issued to a worker
   * at registration time.
   */
  getWorkerToken(workerId: string): string | undefined {
    return this.tokens.get(workerId)?.token;
  }

  /** HTTP port this server listens on (read-only accessor for bootstrap helpers). */
  get port(): number {
    return this.options.port;
  }

  /**
   * The product credential store. Operators issue/rotate/revoke product
   * tokens through this (a product authenticates with its token and is
   * scoped to its own resources). Also used by the operator API + tests.
   */
  get products(): ProductCredentialStore {
    return this.productCredentials;
  }

  async start(): Promise<{ port: number; url: string }> {
    this.deps = {
      plane: this.plane,
      tokens: this.tokens,
      audit: this.audit,
      metrics: this.metrics,
      modelsTemplate: this.modelsTemplate,
      machines: this.machines,
      handRecipes: this.handRecipes,
      skills: this.skills,
      productCredentials: this.productCredentials,
      logger: this.logger,
      adminToken: this.adminToken,
      advertiseUrl: this.options.advertiseUrl,
      port: this.options.port,
      version: this.options.version ?? '0.0.0',
      startedAt: this.startedAt,
    };

    // Build the router. Order doesn't matter for correctness (the router
    // matches by method+pattern), but keep modules grouped for readability.
    this.router = new Router();
    const allRoutes: RouteDefinition[] = [
      ...healthRoutes(this.deps),
      ...uiRoutes(this.deps),
      ...workerRoutes(this.deps),
      ...agentRoutes(this.deps),
      ...sessionRoutes(this.deps),
      ...wakeRoutes(this.deps),
      ...operatorRoutes(this.deps),
      ...modelsRoutes(this.deps),
      ...machineRoutes(this.deps),
      ...handRecipeRoutes(this.deps),
      ...skillRegistryRoutes(this.deps),
      ...productCredentialRoutes(this.deps),
      ...auditRoutes(this.deps),
    ];
    // Wrap each route. Metrics first (so 429s still get counted), then
    // rate limit (except for streaming and the unbounded send call).
    const rl = this.options.rateLimit === null
      ? null
      : (this.options.rateLimit ?? [120, 20]);
    const rateLimitMw = rl ? withRateLimit({ capacity: rl[0], refillPerSecond: rl[1] }) : null;

    for (const route of allRoutes) {
      const exemptFromRateLimit =
        route.pattern.includes('/events/stream')
        || route.pattern.endsWith('/send');
      const before = [withMetrics(this.metrics, route.name ?? `${route.method} ${route.pattern}`)];
      if (rateLimitMw && !exemptFromRateLimit) before.push(rateLimitMw);
      this.router.add({
        ...route,
        middleware: [...before, ...(route.middleware ?? [])],
      });
    }

    this.server = createServer((req, res) => {
      const work = this.handle(req, res);
      this.inflight.add(work);
      void work.finally(() => this.inflight.delete(work));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    const tick = this.options.wakeTickMs ?? 1_000;
    if (tick > 0) {
      this.wakeScheduler = new ManagedRuntimeWakeScheduler({
        orchestrator: this.options.controlPlane.orchestrator,
        intervalMs: tick,
        onWake: (wake) => this.deliverWake(wake),
        onError: (error, wake) => {
          this.logger.warn?.(
            wake
              ? `[a8s-server] wake ${wake.wakeId} for agent ${wake.agentId} failed: ${errorMessage(error)}`
              : `[a8s-server] wake tick error: ${errorMessage(error)}`,
          );
          if (wake) this.metrics.wakesTotal.inc({ outcome: 'failed' });
        },
      });
      this.wakeScheduler.start();
    }

    // Read the actually-bound port from the server, so `port: 0` (let the OS
    // pick a free port atomically) works and returns the real port. This is
    // what lets callers/tests avoid the probe-then-bind TOCTOU race.
    const addr = this.server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : this.options.port;
    const url = `http://localhost:${boundPort}`;
    this.logger.log?.(`[a8s-server] listening on ${url}`);
    return { port: boundPort, url };
  }

  async stop(): Promise<void> {
    this.wakeScheduler?.stop();
    this.wakeScheduler = null;

    if (!this.server) return;

    // Refuse new connections, wait for inflight (with timeout).
    const drainMs = this.options.drainTimeoutMs ?? 10_000;
    const drainStarted = Date.now();
    this.server.close(() => { /* fired after sockets close */ });

    while (this.inflight.size > 0 && Date.now() - drainStarted < drainMs) {
      await Promise.race([
        Promise.all(this.inflight),
        new Promise((r) => setTimeout(r, 100)),
      ]);
    }
    if (this.inflight.size > 0) {
      this.logger.warn?.(
        `[a8s-server] drain timeout: ${this.inflight.size} request(s) still in flight after ${drainMs}ms`,
      );
    }
    // Force close lingering sockets (Node keeps the listener open as long
    // as any socket is alive).
    this.server.closeAllConnections?.();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const matched = await this.router!.dispatch(req, res);
      if (!matched && !res.writableEnded) {
        writeJson(res, 404, errorPayloadSchema.parse({
          error: { code: 'not_found', message: `no route for ${req.method} ${req.url}` },
        }));
      }
    } catch (error) {
      this.logger.error?.('[a8s-server] unhandled dispatch error:', error);
      if (!res.headersSent) {
        writeJson(res, 500, errorPayloadSchema.parse({
          error: { code: 'internal_error', message: errorMessage(error) },
        }));
      }
    }
  }

  /**
   * Wake delivery: turn a claimed RuntimeWake into a send() call on
   * the agent's owning worker. Failures throw so the scheduler marks
   * the wake as failed.
   */
  private async deliverWake(wake: RuntimeWake): Promise<void> {
    const loc = this.plane.getAgentLocation(wake.agentId);
    if (!loc.workerId) {
      throw new Error(`agent ${wake.agentId} has no assigned worker; cannot deliver wake`);
    }
    const entry = this.tokens.get(loc.workerId);
    if (!entry) {
      throw new Error(`no token for worker ${loc.workerId}; cannot deliver wake`);
    }
    const promptParts = [`[system wake] reason: ${wake.reason}`];
    if (wake.sessionId) promptParts.push(`session: ${wake.sessionId}`);
    if (wake.payload) promptParts.push(`payload: ${JSON.stringify(wake.payload)}`);
    const body = JSON.stringify({
      prompt: promptParts.join('\n'),
      sessionId: wake.sessionId,
      requestId: `wake-${wake.wakeId}`,
    });
    const response = await fetch(`${entry.callbackUrl}${WORKER_PATHS.agentSend(wake.agentId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`worker ${loc.workerId} send failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    this.metrics.wakesTotal.inc({ outcome: 'delivered' });
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
