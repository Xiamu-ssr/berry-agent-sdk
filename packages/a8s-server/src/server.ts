// ============================================================
// @berry-agent/a8s-server — Control plane HTTP service
// ============================================================
// Standalone HTTP server that wraps a ControlPlane. Workers register
// here; products call here to create/list/send to agents. Worker tokens
// are issued at registration and required on subsequent worker calls.
//
// Wire protocol comes from @berry-agent/cluster-protocol — never define
// new shapes here, only implement the existing endpoints.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  SSE_LAST_EVENT_ID_HEADER,
  WORKER_AUTH_HEADER,
  agentLocationSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  errorPayloadSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
  operatorClusterReportSchema,
  operatorLeaseListResponseSchema,
  operatorLeaseSchema,
  operatorOkResponseSchema,
  operatorWorkerListResponseSchema,
  operatorWorkerSchema,
  parseAdminAuthHeader,
  parseWorkerAuthHeader,
  scheduleWakeRequestSchema,
  scheduleWakeResponseSchema,
  sendRequestSchema,
  workerAuthHeader,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  workerRegistrationRequestSchema,
  workerRegistrationResponseSchema,
  workerWithdrawRequestSchema,
  WORKER_PATHS,
} from '@berry-agent/cluster-protocol';
import {
  ControlPlane,
  HttpWorkerNode,
  type ControlPlaneOptions,
} from '@berry-agent/a8s';
import type { WorkerAgentSpec } from '@berry-agent/worker';

// We can't import `createServer` from node:http and also have a module
// called createServer here without conflict. Use namespacing.
const nodeCreateServer = createServer;

export interface A8sServerOptions<TEntry = unknown> {
  port: number;
  /** ControlPlane config (orchestrator + scheduler + logger). */
  controlPlane: ControlPlaneOptions<TEntry>;
  /**
   * Shared secret required on every product-/operator-scope request
   * (anything under /v1/agents, /v1/wakes, /v1/operator). When unset, a8s
   * runs in **insecure dev mode** and accepts all such requests — fine
   * for tests and laptop dev, never for a real deployment. Logs a loud
   * warning at startup when this is the case.
   *
   * Workers do not present this token after registration — they have
   * their own per-worker token issued at /v1/workers/register. The
   * registration call itself accepts the admin token (acts as the
   * bootstrap secret a worker proves it knows when joining).
   */
  adminToken?: string;
  /** Optional version string surfaced via /health. */
  version?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface WorkerToken {
  workerId: string;
  token: string;
  callbackUrl: string;
  capacity: number;
  heartbeatTtlMs: number;
}

export class A8sServer<TEntry = unknown> {
  private server: Server | null = null;
  readonly plane: ControlPlane<TEntry>;
  private readonly options: A8sServerOptions<TEntry>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly tokens = new Map<string, WorkerToken>(); // workerId -> token info
  private readonly startedAt = Date.now();
  private readonly adminToken: string | undefined;

  constructor(options: A8sServerOptions<TEntry>) {
    this.options = options;
    this.plane = new ControlPlane<TEntry>(options.controlPlane);
    this.logger = options.logger ?? console;
    this.adminToken = options.adminToken;
    if (!this.adminToken) {
      this.logger.warn?.(
        '[a8s-server] WARNING: starting without --admin-token; all product-scope endpoints are open. Use only for dev/tests.',
      );
    }
  }

  async start(): Promise<{ port: number; url: string }> {
    this.server = nodeCreateServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error?.('[a8s-server] unhandled error:', error);
        if (!res.headersSent) {
          writeJson(res, 500, errorPayloadSchema.parse({
            error: { code: 'internal_error', message: errorMessage(error) },
          }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    const url = `http://localhost:${this.options.port}`;
    this.logger.log?.(`[a8s-server] listening on ${url}`);
    return { port: this.options.port, url };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  /**
   * Test/debug accessor — returns the bearer token that was issued to a
   * worker at registration time. Not exposed over the wire (workers
   * receive their own token in the registration response).
   */
  getWorkerToken(workerId: string): string | undefined {
    return this.tokens.get(workerId)?.token;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // ---- Unauthenticated: health probe ----
    if (req.method === 'GET' && url === A8S_PATHS.health) {
      return writeJson(res, 200, healthResponseSchema.parse({
        ok: true,
        version: this.options.version ?? '0.0.0',
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      }));
    }

    // ---- Worker-scope: authenticated per-worker (own assertWorkerAuth) ----
    // Registration accepts the admin token (bootstrap), heartbeat/withdraw
    // use the per-worker token issued at registration.
    if (req.method === 'POST' && url === A8S_PATHS.workersRegister) {
      if (!this.assertAdminAuth(req, res, { context: 'workers/register' })) return;
      return this.handleWorkerRegister(req, res);
    }

    const heartbeatMatch = url.match(/^\/v1\/workers\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch && req.method === 'POST') {
      return this.handleWorkerHeartbeat(decodeURIComponent(heartbeatMatch[1]), req, res);
    }

    const withdrawMatch = url.match(/^\/v1\/workers\/([^/]+)\/withdraw$/);
    if (withdrawMatch && req.method === 'POST') {
      return this.handleWorkerWithdraw(decodeURIComponent(withdrawMatch[1]), req, res);
    }

    // ---- Product-/operator-scope: require admin token ----
    if (!this.assertAdminAuth(req, res)) return;

    if (req.method === 'GET' && url === A8S_PATHS.agents) {
      return this.handleListAgents(res);
    }

    if (req.method === 'POST' && url === A8S_PATHS.agents) {
      return this.handleCreateAgent(req, res);
    }

    const agentSendMatch = url.match(/^\/v1\/agents\/([^/]+)\/send$/);
    if (agentSendMatch && req.method === 'POST') {
      return this.handleAgentSend(decodeURIComponent(agentSendMatch[1]), req, res);
    }

    // /agents/:id/events/stream — long-lived SSE
    const streamMatch = url.match(/^(\/v1\/agents\/([^/]+)\/events\/stream)(\?.*)?$/);
    if (streamMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(streamMatch[2]);
      const subpath = `${streamMatch[1]}${streamMatch[3] ?? ''}`;
      return this.proxyStreamToWorker(agentId, subpath, req, res);
    }

    // /agents/:id/sessions/:sid/events — proxy paginated event read
    const sessionEventsMatch = url.match(/^(\/v1\/agents\/([^/]+)\/sessions\/[^/]+\/events)(\?.*)?$/);
    if (sessionEventsMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(sessionEventsMatch[2]);
      const subpath = `${sessionEventsMatch[1]}${sessionEventsMatch[3] ?? ''}`;
      return this.proxyGetToWorker(agentId, subpath, res);
    }

    // /agents/:id/sessions — proxy session list
    const sessionListMatch = url.match(/^(\/v1\/agents\/([^/]+)\/sessions)(\?.*)?$/);
    if (sessionListMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(sessionListMatch[2]);
      const subpath = `${sessionListMatch[1]}${sessionListMatch[3] ?? ''}`;
      return this.proxyGetToWorker(agentId, subpath, res);
    }

    const agentDeleteMatch = url.match(/^\/v1\/agents\/([^/]+)$/);
    if (agentDeleteMatch && req.method === 'DELETE') {
      return this.handleAgentDelete(decodeURIComponent(agentDeleteMatch[1]), res);
    }
    if (agentDeleteMatch && req.method === 'GET') {
      return this.handleAgentLocation(decodeURIComponent(agentDeleteMatch[1]), res);
    }

    if (req.method === 'POST' && url === A8S_PATHS.wakesSchedule) {
      return this.handleScheduleWake(req, res);
    }

    // ---- Operator endpoints ----
    if (req.method === 'GET' && url === A8S_PATHS.operatorCluster) {
      return this.handleOperatorCluster(res);
    }
    if (req.method === 'GET' && url === A8S_PATHS.operatorWorkers) {
      return this.handleOperatorListWorkers(res);
    }
    if (req.method === 'GET' && url === A8S_PATHS.operatorLeases) {
      return this.handleOperatorListLeases(res);
    }
    const drainMatch = url.match(/^\/v1\/operator\/workers\/([^/]+)\/drain$/);
    if (drainMatch && req.method === 'POST') {
      return this.handleOperatorDrainWorker(decodeURIComponent(drainMatch[1]), res);
    }
    const undrainMatch = url.match(/^\/v1\/operator\/workers\/([^/]+)\/undrain$/);
    if (undrainMatch && req.method === 'POST') {
      return this.handleOperatorUndrainWorker(decodeURIComponent(undrainMatch[1]), res);
    }
    const evictMatch = url.match(/^\/v1\/operator\/workers\/([^/]+)\/evict$/);
    if (evictMatch && req.method === 'POST') {
      return this.handleOperatorEvictWorker(decodeURIComponent(evictMatch[1]), res);
    }

    return writeJson(res, 404, errorPayloadSchema.parse({
      error: { code: 'not_found', message: `no route for ${req.method} ${url}` },
    }));
  }

  /**
   * Gate for product-scope endpoints. When the server was started without
   * an admin token (dev mode), this is a no-op. Returns false and writes
   * a 401 when auth fails, true to continue.
   *
   * Constant-time compare avoids leaking token length / prefix through
   * timing side channels — admin tokens are long-lived secrets.
   */
  private assertAdminAuth(req: IncomingMessage, res: ServerResponse, _ctx?: { context?: string }): boolean {
    if (!this.adminToken) return true; // dev mode
    const presented = parseAdminAuthHeader(req.headers[ADMIN_AUTH_HEADER.toLowerCase()] as string | undefined);
    if (!presented || !constantTimeEqual(presented, this.adminToken)) {
      writeJson(res, 401, errorPayloadSchema.parse({
        error: { code: 'unauthorized', message: 'missing or invalid admin token' },
      }));
      return false;
    }
    return true;
  }

  private async handleWorkerRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = workerRegistrationRequestSchema.parse(body);

    const token = randomBytes(32).toString('base64url');
    this.tokens.set(parsed.workerId, {
      workerId: parsed.workerId,
      token,
      callbackUrl: parsed.callbackUrl,
      capacity: parsed.capacity,
      heartbeatTtlMs: parsed.heartbeatTtlMs,
    });

    // Register the worker entry in the durable orchestrator, then wire
    // an HttpWorkerNode into the in-memory plane so subsequent
    // createAgent calls can route through it.
    await this.options.controlPlane.orchestrator.registerWorker({
      workerId: parsed.workerId,
      holderId: parsed.workerId,
      capacity: parsed.capacity,
      heartbeatTtlMs: parsed.heartbeatTtlMs,
      labels: parsed.labels,
    });
    this.plane.addWorker(new HttpWorkerNode<TEntry>({
      workerId: parsed.workerId,
      callbackUrl: parsed.callbackUrl,
      workerToken: token,
      labels: parsed.labels,
    }));

    return writeJson(res, 200, workerRegistrationResponseSchema.parse({
      workerId: parsed.workerId,
      heartbeatTtlMs: parsed.heartbeatTtlMs,
      workerToken: token,
    }));
  }

  private async handleWorkerHeartbeat(workerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.assertWorkerAuth(workerId, req, res)) return;
    const body = await readJson(req);
    workerHeartbeatRequestSchema.parse(body);
    const entry = this.tokens.get(workerId)!;
    const refreshed = await this.options.controlPlane.orchestrator.heartbeatWorker(workerId, entry.heartbeatTtlMs);
    if (!refreshed) {
      return writeJson(res, 410, errorPayloadSchema.parse({
        error: { code: 'worker_evicted', message: `worker ${workerId} has been evicted; please re-register` },
      }));
    }
    return writeJson(res, 200, workerHeartbeatResponseSchema.parse({
      ok: true,
      heartbeatTtlMs: entry.heartbeatTtlMs,
    }));
  }

  private async handleWorkerWithdraw(workerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.assertWorkerAuth(workerId, req, res)) return;
    const body = await readJson(req);
    workerWithdrawRequestSchema.parse(body);
    await this.options.controlPlane.orchestrator.withdrawWorker(workerId);
    this.plane.removeWorker(workerId);
    this.tokens.delete(workerId);
    return writeJson(res, 200, { ok: true });
  }

  private handleListAgents(res: ServerResponse): void {
    const agents = this.plane.listAgents().map((entry) =>
      agentLocationSchema.parse({ agentId: entry.agentId, workerId: entry.workerId }),
    );
    writeJson(res, 200, listAgentsResponseSchema.parse({ agents }));
  }

  private async handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = createAgentRequestSchema.parse(body);

    // Reconstruct a partial WorkerAgentSpec from the wire spec. Worker
    // daemons resolve the full spec on their side (hostTools, home, etc.).
    const wireSpec: WorkerAgentSpec = {
      agentId: parsed.spec.agentId,
      workspace: parsed.spec.workspace,
      projectRoot: parsed.spec.projectRoot,
      // Cast through unknown so we don't import core's AgentHome here just
      // for typing. The worker daemon's resolveSpec callback fills it in.
      home: undefined as unknown as WorkerAgentSpec['home'],
      model: parsed.spec.model,
      ensureDefaultMcpConfig: parsed.spec.ensureDefaultMcpConfig,
    };

    const result = await this.plane.createAgent(
      wireSpec,
      (parsed.entry ?? {}) as TEntry,
    );

    // Acquire a durable lease so cluster failover semantics hold across
    // process boundaries. The lease binds (agentId, workerId) in the
    // orchestrator store; if this control plane process dies and another
    // resumes, hydrateAssignments() will rebuild the in-memory map from
    // this lease.
    const acquired = await this.options.controlPlane.orchestrator.acquireLease({
      agentId: result.agentId,
      holderId: result.workerId,
      workerId: result.workerId,
      ttlMs: 5 * 60_000,
    });
    if (!acquired.acquired) {
      this.logger.warn?.(
        `[a8s-server] lease for ${result.agentId} already held by ${acquired.active.holderId}`,
      );
    }
    const leaseId = acquired.acquired ? acquired.lease.leaseId : acquired.active.leaseId;

    return writeJson(res, 200, createAgentResponseSchema.parse({
      agentId: result.agentId,
      workerId: result.workerId,
      leaseId,
    }));
  }

  private handleAgentLocation(agentId: string, res: ServerResponse): void {
    const loc = this.plane.getAgentLocation(agentId);
    writeJson(res, 200, agentLocationSchema.parse(loc));
  }

  private async handleAgentDelete(agentId: string, res: ServerResponse): Promise<void> {
    await this.plane.deleteAgent(agentId);
    writeJson(res, 200, { ok: true });
  }

  private async handleAgentSend(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = sendRequestSchema.parse(body);
    const loc = this.plane.getAgentLocation(agentId);
    if (!loc.workerId) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_assigned', message: `agent "${agentId}" has no assigned worker` },
      }));
    }
    const entry = this.tokens.get(loc.workerId);
    if (!entry) {
      return writeJson(res, 500, errorPayloadSchema.parse({
        error: { code: 'worker_token_missing', message: `no token for worker ${loc.workerId}` },
      }));
    }
    // Forward to the worker daemon's send endpoint.
    const response = await fetch(`${entry.callbackUrl}${WORKER_PATHS.agentSend(agentId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
      },
      body: JSON.stringify(parsed),
    });
    const text = await response.text();
    res.statusCode = response.status;
    res.setHeader('content-type', 'application/json');
    res.end(text);
  }

  // ============================================================
  // Operator endpoints
  // ============================================================
  // These read from the durable orchestrator (true source of truth for
  // cluster membership + leases) plus the in-memory token table (live
  // callback URL). Both are needed: the orchestrator knows what *should*
  // be running, the token table knows where the worker actually answers.

  private async handleOperatorCluster(res: ServerResponse): Promise<void> {
    const workers = await this.options.controlPlane.orchestrator.listWorkers();
    const planeWorkers = this.plane.listWorkers();
    let usedTotal = 0;
    let capacityTotal = 0;
    let active = 0, draining = 0, evicted = 0;
    for (const w of workers) {
      if (w.state === 'active') { active++; capacityTotal += w.capacity; }
      else if (w.state === 'draining') { draining++; capacityTotal += w.capacity; }
      else if (w.state === 'evicted' || w.state === 'withdrawn') evicted++;
    }
    for (const node of planeWorkers) {
      // WorkerNode.workerId() → string; the live mount count lives in plane
      // via listAgents — count assignments per worker.
    }
    const agents = this.plane.listAgents();
    usedTotal = agents.length;
    const report = operatorClusterReportSchema.parse({
      workerCount: {
        total: workers.length,
        active,
        draining,
        evicted,
      },
      capacity: {
        total: capacityTotal,
        used: usedTotal,
        available: Math.max(0, capacityTotal - usedTotal),
      },
      agentCount: agents.length,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    });
    writeJson(res, 200, report);
  }

  private async handleOperatorListWorkers(res: ServerResponse): Promise<void> {
    const orchWorkers = await this.options.controlPlane.orchestrator.listWorkers();
    const agents = this.plane.listAgents();
    const usedByWorker = new Map<string, number>();
    for (const a of agents) {
      if (!a.workerId) continue;
      usedByWorker.set(a.workerId, (usedByWorker.get(a.workerId) ?? 0) + 1);
    }
    const list = orchWorkers.map((w) => {
      const tok = this.tokens.get(w.workerId);
      return operatorWorkerSchema.parse({
        workerId: w.workerId,
        state: w.state,
        capacity: w.capacity,
        used: usedByWorker.get(w.workerId) ?? 0,
        callbackUrl: tok?.callbackUrl ?? 'http://unknown',
        labels: w.labels,
        registeredAt: w.registeredAt,
        heartbeatAt: w.heartbeatAt,
        heartbeatExpiresAt: w.heartbeatExpiresAt,
        drainedAt: w.drainedAt,
        evictedAt: w.evictedAt,
        withdrawnAt: w.withdrawnAt,
      });
    });
    writeJson(res, 200, operatorWorkerListResponseSchema.parse({ workers: list }));
  }

  private async handleOperatorListLeases(res: ServerResponse): Promise<void> {
    const leases = await this.options.controlPlane.orchestrator.listLeases();
    const list = leases.map((l) => operatorLeaseSchema.parse({
      leaseId: l.leaseId,
      agentId: l.agentId,
      holderId: l.holderId,
      workerId: l.workerId,
      state: l.state,
      acquiredAt: l.acquiredAt,
      renewedAt: l.renewedAt,
      expiresAt: l.expiresAt,
      releasedAt: l.releasedAt,
      sessionId: l.sessionId,
    }));
    writeJson(res, 200, operatorLeaseListResponseSchema.parse({ leases: list }));
  }

  private async handleOperatorDrainWorker(workerId: string, res: ServerResponse): Promise<void> {
    const result = await this.options.controlPlane.orchestrator.drainWorker(workerId);
    if (!result) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'unknown_worker', message: `worker "${workerId}" not registered` },
      }));
    }
    return writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
  }

  private async handleOperatorUndrainWorker(workerId: string, res: ServerResponse): Promise<void> {
    // Re-registering with the same worker resets state to 'active'. We
    // achieve the same effect by re-running registerWorker against the
    // cached token entry — the registration handler already does this
    // transition. Avoid hidden state by going through the durable path.
    const tok = this.tokens.get(workerId);
    if (!tok) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'unknown_worker', message: `worker "${workerId}" not registered with this control plane process` },
      }));
    }
    await this.options.controlPlane.orchestrator.registerWorker({
      workerId,
      holderId: workerId,
      capacity: tok.capacity,
      heartbeatTtlMs: tok.heartbeatTtlMs,
    });
    return writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
  }

  private async handleOperatorEvictWorker(workerId: string, res: ServerResponse): Promise<void> {
    // withdrawWorker is the durable version of evict — releases the
    // worker entry + all its leases atomically. Removing from the
    // in-memory plane stops further data-plane routing.
    const result = await this.options.controlPlane.orchestrator.withdrawWorker(workerId);
    if (!result) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'unknown_worker', message: `worker "${workerId}" not registered` },
      }));
    }
    this.plane.removeWorker(workerId);
    this.tokens.delete(workerId);
    return writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
  }

  /**
   * Generic GET proxy used by data-plane reads (session list, paginated
   * events). Resolves agent → worker via the plane, attaches the worker
   * bearer token, forwards the path verbatim, and streams the response
   * back. Worker daemon's path layout matches a8s 1:1 for these endpoints.
   */
  private async proxyGetToWorker(agentId: string, subpath: string, res: ServerResponse): Promise<void> {
    const loc = this.plane.getAgentLocation(agentId);
    if (!loc.workerId) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_assigned', message: `agent "${agentId}" has no assigned worker` },
      }));
    }
    const entry = this.tokens.get(loc.workerId);
    if (!entry) {
      return writeJson(res, 500, errorPayloadSchema.parse({
        error: { code: 'worker_token_missing', message: `no token for worker ${loc.workerId}` },
      }));
    }
    const response = await fetch(`${entry.callbackUrl}${subpath}`, {
      method: 'GET',
      headers: {
        [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
      },
    });
    const text = await response.text();
    res.statusCode = response.status;
    res.setHeader('content-type', 'application/json');
    res.end(text);
  }

  /**
   * Long-lived SSE proxy. We can't use fetch(...).text() because the
   * stream is unbounded — we pipe the worker's response body straight
   * through to the client and let either side close it. Forwards
   * Last-Event-ID so resume across reconnects works end-to-end.
   */
  private async proxyStreamToWorker(
    agentId: string,
    subpath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const loc = this.plane.getAgentLocation(agentId);
    if (!loc.workerId) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_assigned', message: `agent "${agentId}" has no assigned worker` },
      }));
    }
    const entry = this.tokens.get(loc.workerId);
    if (!entry) {
      return writeJson(res, 500, errorPayloadSchema.parse({
        error: { code: 'worker_token_missing', message: `no token for worker ${loc.workerId}` },
      }));
    }

    const lastEventId = req.headers[SSE_LAST_EVENT_ID_HEADER.toLowerCase()] as string | undefined;
    const upstreamHeaders: Record<string, string> = {
      [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
      accept: 'text/event-stream',
    };
    if (lastEventId) upstreamHeaders[SSE_LAST_EVENT_ID_HEADER] = lastEventId;

    const upstream = await fetch(`${entry.callbackUrl}${subpath}`, {
      method: 'GET',
      headers: upstreamHeaders,
    });

    res.statusCode = upstream.status;
    if (upstream.status !== 200 || !upstream.body) {
      const text = await upstream.text();
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.end(text);
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const cancel = (): void => {
      try { void reader.cancel(); } catch { /* swallow */ }
    };
    req.on('close', cancel);
    req.on('aborted', cancel);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && !res.writableEnded) res.write(value);
        if (res.writableEnded) {
          cancel();
          break;
        }
      }
    } catch (error) {
      this.logger.warn?.('[a8s-server] SSE upstream read failed:', error);
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  private async handleScheduleWake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = scheduleWakeRequestSchema.parse(body);
    const wake = await this.plane.scheduleWake(parsed);
    return writeJson(res, 200, scheduleWakeResponseSchema.parse({
      wakeId: wake.wakeId,
      dueAt: wake.dueAt,
    }));
  }

  private assertWorkerAuth(workerId: string, req: IncomingMessage, res: ServerResponse): boolean {
    const expected = this.tokens.get(workerId);
    if (!expected) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'unknown_worker', message: `worker ${workerId} is not registered` },
      }));
      return false;
    }
    const presented = parseWorkerAuthHeader(req.headers[WORKER_AUTH_HEADER.toLowerCase()] as string | undefined);
    if (presented !== expected.token) {
      writeJson(res, 401, errorPayloadSchema.parse({
        error: { code: 'unauthorized', message: 'invalid worker token' },
      }));
      return false;
    }
    return true;
  }
}

// ============================================================
// Helpers
// ============================================================

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    req.on('data', (chunk) => { buffer += chunk; });
    req.on('end', () => {
      if (!buffer) { resolve({}); return; }
      try { resolve(JSON.parse(buffer)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Length-independent timing-safe compare for short secrets. */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
