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
  WORKER_AUTH_HEADER,
  agentLocationSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  errorPayloadSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
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

  constructor(options: A8sServerOptions<TEntry>) {
    this.options = options;
    this.plane = new ControlPlane<TEntry>(options.controlPlane);
    this.logger = options.logger ?? console;
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

    if (req.method === 'GET' && url === A8S_PATHS.health) {
      return writeJson(res, 200, healthResponseSchema.parse({
        ok: true,
        version: this.options.version ?? '0.0.0',
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      }));
    }

    if (req.method === 'POST' && url === A8S_PATHS.workersRegister) {
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

    return writeJson(res, 404, errorPayloadSchema.parse({
      error: { code: 'not_found', message: `no route for ${req.method} ${url}` },
    }));
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
