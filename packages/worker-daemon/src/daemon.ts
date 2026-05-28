// ============================================================
// @berry-agent/worker-daemon — Worker HTTP server
// ============================================================
// Wraps a local @berry-agent/worker Worker behind an HTTP server that
// implements the WORKER_PATHS wire protocol. The server accepts requests
// from a8s (run/stop agents, capacity probes) and authenticates via the
// Bearer token issued at registration time.
//
// Lifecycle:
//   1. start() spins up the HTTP server.
//   2. registerWith(a8sUrl) POSTs to a8s /workers/register, receives a
//      token, starts heartbeat loop.
//   3. handleStopSignal() drains and withdraws cleanly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import {
  WORKER_AUTH_HEADER,
  WORKER_PATHS,
  errorPayloadSchema,
  parseWorkerAuthHeader,
  sendRequestSchema,
  workerCapacityResponseSchema,
  workerHasAgentResponseSchema,
  workerRunAgentRequestSchema,
  workerRunAgentResponseSchema,
  workerStopAgentResponseSchema,
  healthResponseSchema,
  type HealthResponse,
} from '@berry-agent/cluster-protocol';
import type { Worker, WorkerAgentSpec, WorkerEnvironment } from '@berry-agent/worker';

export interface WorkerDaemonOptions<TEntry = unknown> {
  /** Underlying Worker (constructed by host with the env it needs). */
  worker: Worker<TEntry>;
  /** Stable workerId; survives restarts. */
  workerId: string;
  /** Port the daemon listens on. */
  port: number;
  /** Hostname / IP the daemon advertises to a8s (defaults to os.hostname). */
  bindHost?: string;
  /** Token a8s will present on every request. Generated at registerWith time. */
  authToken?: string;
  /** Logger; defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /**
   * Build a real WorkerAgentSpec from the wire spec. The wire spec is
   * intentionally narrow — host code knows how to look up the agent's
   * AgentHome, hostTools, etc. by `agentId` and reconstruct the full spec
   * with non-JSON-transportable fields.
   */
  resolveSpec: (wire: {
    agentId: string;
    workspace: string;
    projectRoot?: string;
    model: string;
    reasoningEffort?: string;
    toolDenylist?: string[];
    ensureDefaultMcpConfig?: boolean;
  }) => WorkerAgentSpec;
  /** Built-in version string surfaced via /health. */
  version?: string;
}

export class WorkerDaemon<TEntry = unknown> {
  private server: Server | null = null;
  private readonly options: WorkerDaemonOptions<TEntry>;
  private readonly worker: Worker<TEntry>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private authToken: string;
  private readonly startedAt = Date.now();

  constructor(options: WorkerDaemonOptions<TEntry>) {
    this.options = options;
    this.worker = options.worker;
    this.logger = options.logger ?? console;
    this.authToken = options.authToken ?? '';
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  async start(): Promise<{ host: string; port: number; callbackUrl: string }> {
    const port = this.options.port;
    const bindHost = this.options.bindHost ?? hostname();

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error?.('[worker-daemon] unhandled error:', error);
        if (!res.headersSent) {
          writeJson(res, 500, errorPayloadSchema.parse({
            error: { code: 'internal_error', message: errorMessage(error) },
          }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });

    const callbackUrl = `http://${bindHost}:${port}`;
    this.logger.log?.(`[worker-daemon] listening on ${callbackUrl}`);
    return { host: bindHost, port, callbackUrl };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Health is unauthenticated.
    if (req.method === 'GET' && url === WORKER_PATHS.health) {
      return writeJson(res, 200, this.healthPayload());
    }

    // Everything else requires the bearer token a8s received at registration.
    if (this.authToken) {
      const presented = parseWorkerAuthHeader(req.headers[WORKER_AUTH_HEADER.toLowerCase()] as string | undefined);
      if (presented !== this.authToken) {
        return writeJson(res, 401, errorPayloadSchema.parse({
          error: { code: 'unauthorized', message: 'invalid worker token' },
        }));
      }
    }

    if (req.method === 'GET' && url === WORKER_PATHS.capacity) {
      const w = this.worker.worker();
      const used = this.worker.ids().length;
      const payload = workerCapacityResponseSchema.parse({
        used,
        total: w?.capacity,
      });
      return writeJson(res, 200, payload);
    }

    // /agents/:id/{run,stop,send,active-session,has}
    const agentMatch = url.match(/^\/v1\/agents\/([^/]+)\/(run|stop|send|active-session|has)$/);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const action = agentMatch[2];

      if (action === 'run' && req.method === 'POST') return this.handleRunAgent(agentId, req, res);
      if (action === 'stop' && req.method === 'POST') return this.handleStopAgent(agentId, res);
      if (action === 'has' && req.method === 'GET') return this.handleHasAgent(agentId, res);
      if (action === 'send' && req.method === 'POST') return this.handleSendAgent(agentId, req, res);
      if (action === 'active-session' && req.method === 'GET') return this.handleActiveSession(agentId, res);
    }

    return writeJson(res, 404, errorPayloadSchema.parse({
      error: { code: 'not_found', message: `no route for ${req.method} ${url}` },
    }));
  }

  private healthPayload(): HealthResponse {
    return healthResponseSchema.parse({
      ok: true,
      version: this.options.version ?? '0.0.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    });
  }

  private async handleRunAgent(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = workerRunAgentRequestSchema.parse(body);
    const spec = this.options.resolveSpec({
      agentId,
      workspace: parsed.spec.workspace,
      projectRoot: parsed.spec.projectRoot,
      model: parsed.spec.model,
      reasoningEffort: parsed.spec.reasoningEffort,
      toolDenylist: parsed.spec.toolDenylist,
      ensureDefaultMcpConfig: parsed.spec.ensureDefaultMcpConfig,
    });

    if (this.worker.supervisor()) {
      await this.worker.runAgent(agentId, (parsed.entry ?? {}) as TEntry, spec);
    } else {
      this.worker.runAgentSync(agentId, (parsed.entry ?? {}) as TEntry, spec);
    }
    return writeJson(res, 200, workerRunAgentResponseSchema.parse({ ok: true }));
  }

  private async handleStopAgent(agentId: string, res: ServerResponse): Promise<void> {
    await this.worker.stopAgent(agentId);
    return writeJson(res, 200, workerStopAgentResponseSchema.parse({ ok: true }));
  }

  private handleHasAgent(agentId: string, res: ServerResponse): void {
    writeJson(res, 200, workerHasAgentResponseSchema.parse({ has: this.worker.has(agentId) }));
  }

  private async handleSendAgent(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const parsed = sendRequestSchema.parse(body);
    const mount = this.worker.get(agentId);
    if (!mount) {
      return writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
    }
    // Forward to the live runtime. Casting prompt because the protocol
    // accepts opaque content blocks — SDK validates them downstream.
    const result = await mount.runtime.send(
      parsed.prompt as Parameters<typeof mount.runtime.send>[0],
      parsed.sessionId ? { sessionId: parsed.sessionId, requestId: parsed.requestId } : { requestId: parsed.requestId },
    );
    return writeJson(res, 200, {
      sessionId: result.sessionId,
      result: result as unknown as Record<string, unknown>,
    });
  }

  private handleActiveSession(agentId: string, res: ServerResponse): void {
    const mount = this.worker.get(agentId);
    if (!mount) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
      return;
    }
    writeJson(res, 200, { sessionId: mount.runtime.getActiveSessionId() ?? null });
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
