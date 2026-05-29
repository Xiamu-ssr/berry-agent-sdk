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
  SSE_LAST_EVENT_ID_HEADER,
  SSE_SESSION_QUERY_PARAM,
  WORKER_AUTH_HEADER,
  WORKER_PATHS,
  errorPayloadSchema,
  parseWorkerAuthHeader,
  sendRequestSchema,
  sessionEventsRequestSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
  workerCapacityResponseSchema,
  workerHasAgentResponseSchema,
  workerRunAgentRequestSchema,
  workerRunAgentResponseSchema,
  workerStopAgentResponseSchema,
  healthResponseSchema,
  type HealthResponse,
} from '@berry-agent/cluster-protocol';
import type { Worker, WorkerAgentSpec } from '@berry-agent/worker';

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
    /** Agent-level labels stamped at createAgent time (free-form). */
    labels?: Readonly<Record<string, string>>;
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

    // /agents/:id/events/stream — long-lived SSE
    const streamMatch = url.match(/^\/v1\/agents\/([^/]+)\/events\/stream(?:\?.*)?$/);
    if (streamMatch && req.method === 'GET') {
      return this.handleEventStream(decodeURIComponent(streamMatch[1]), req, res);
    }

    // /agents/:id/sessions  &  /agents/:id/sessions/:sid/events
    const sessionEventsMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/events(?:\?.*)?$/);
    if (sessionEventsMatch && req.method === 'GET') {
      return this.handleSessionEvents(
        decodeURIComponent(sessionEventsMatch[1]),
        decodeURIComponent(sessionEventsMatch[2]),
        req,
        res,
      );
    }
    const sessionListMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions(?:\?.*)?$/);
    if (sessionListMatch && req.method === 'GET') {
      return this.handleSessionList(decodeURIComponent(sessionListMatch[1]), res);
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
      labels: parsed.spec.labels,
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

  private async handleSessionList(agentId: string, res: ServerResponse): Promise<void> {
    const mount = this.worker.get(agentId);
    if (!mount) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
      return;
    }
    // includeMessages=false keeps the response cheap — clients render the
    // sidebar from this, then page events via the per-session endpoint.
    const views = await mount.runtime.listSessionViews({ includeMessages: false });
    const sessions = views.map((v) => sessionSummarySchema.parse({
      id: v.id,
      title: v.title,
      createdAt: v.createdAt,
      lastActiveAt: v.lastActiveAt,
      status: v.status,
      messageCount: v.messages.length,
    }));
    writeJson(res, 200, sessionListResponseSchema.parse({ sessions }));
  }

  private async handleSessionEvents(
    agentId: string,
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const mount = this.worker.get(agentId);
    if (!mount) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
      return;
    }
    const params = parseQuery(req.url ?? '');
    const parsed = sessionEventsRequestSchema.parse({
      before: params.before,
      limit: params.limit !== undefined ? Number(params.limit) : undefined,
    });
    const limit = Math.min(parsed.limit ?? 200, 1000);

    // Read the whole log and paginate in-memory. For long sessions this is
    // O(N) per request — acceptable for the alpha; revisit when sessions
    // routinely exceed ~10k events. The file store already streams + parses
    // each line, so memory pressure is proportional to events only.
    const all = await mount.runtime.getSessionEvents(sessionId);
    let upperExclusive = all.length;
    if (parsed.before) {
      const idx = all.findIndex((e) => e.id === parsed.before);
      upperExclusive = idx === -1 ? all.length : idx;
    }
    const lowerInclusive = Math.max(0, upperExclusive - limit);
    const page = all.slice(lowerInclusive, upperExclusive);
    const reachedStart = lowerInclusive === 0;
    const nextBefore = reachedStart || page.length === 0 ? null : page[0].id;
    writeJson(res, 200, sessionEventsResponseSchema.parse({
      events: page.map((e) => e as unknown as Record<string, unknown>),
      nextBefore,
      reachedStart,
    }));
  }

  /**
   * Long-lived Server-Sent Events stream. Subscribes to the agent's
   * event log; every appended SessionEvent is forwarded as one SSE
   * message. Closing the socket unsubscribes.
   *
   * Resume semantics: when `Last-Event-ID` is provided (or
   * `?last_event_id=` query string), the handler first replays any
   * persisted events appended *after* that id, then transitions into
   * live mode. This makes drops invisible to a well-behaved EventSource
   * client that retries with its last seen id.
   *
   * Session filter: `?session=<sid>` narrows the stream to one session;
   * omit to receive every session event for the agent.
   */
  private async handleEventStream(
    agentId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const mount = this.worker.get(agentId);
    if (!mount) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
      return;
    }
    const params = parseQuery(req.url ?? '');
    const sessionFilter = params[SSE_SESSION_QUERY_PARAM] ?? undefined;
    const lastEventId = (req.headers[SSE_LAST_EVENT_ID_HEADER.toLowerCase()] as string | undefined)
      ?? params.last_event_id
      ?? undefined;

    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    // Disable proxy buffering (nginx, etc.) — events must flush promptly.
    res.setHeader('x-accel-buffering', 'no');
    // Flush headers immediately so the client knows the stream is alive.
    res.flushHeaders?.();

    // Subscribe before replay so we don't miss anything appended between
    // the historical read and the live transition. Buffer live events
    // during the replay window and dedupe by id.
    const replayedIds = new Set<string>();
    const liveBuffer: Array<{ sessionId: string; event: SessionEventLike }> = [];
    let mode: 'replay' | 'live' = 'replay';
    const unsubscribe = mount.runtime.subscribeSessionEvents((sid, event) => {
      if (sessionFilter && sid !== sessionFilter) return;
      if (mode === 'replay') {
        liveBuffer.push({ sessionId: sid, event });
        return;
      }
      if (replayedIds.has(event.id)) return;
      writeSse(res, event);
    });

    const close = (): void => {
      try { unsubscribe(); } finally {
        if (!res.writableEnded) res.end();
      }
    };
    req.on('close', close);
    req.on('aborted', close);

    try {
      // Replay step: load historical events for the relevant sessions and
      // stream those that come after lastEventId. With a session filter
      // this is one log; without, we union across every session the agent
      // has on disk.
      const targetSessions = sessionFilter
        ? [sessionFilter]
        : await mount.runtime.listSessionViews({ includeMessages: false }).then((v) => v.map((s) => s.id));

      for (const sid of targetSessions) {
        const events = await mount.runtime.getSessionEvents(sid);
        let startIdx = 0;
        if (lastEventId) {
          const idx = events.findIndex((e) => e.id === lastEventId);
          startIdx = idx === -1 ? 0 : idx + 1;
        }
        for (let i = startIdx; i < events.length; i++) {
          const event = events[i];
          replayedIds.add(event.id);
          writeSse(res, event);
          if (res.writableEnded) {
            unsubscribe();
            return;
          }
        }
      }

      // Drain anything that arrived during replay, then go live.
      mode = 'live';
      for (const { event } of liveBuffer) {
        if (replayedIds.has(event.id)) continue;
        writeSse(res, event);
      }
      // Free the dedupe set once it's no longer needed.
      replayedIds.clear();
    } catch (error) {
      this.logger.warn?.('[worker-daemon] event stream replay failed:', error);
      close();
      return;
    }

    // Periodic keepalive comment so intermediaries don't reap the
    // connection during quiet periods.
    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      res.write(': keepalive\n\n');
    }, 25_000);
    res.on('close', () => clearInterval(keepAlive));
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

function parseQuery(url: string): Record<string, string> {
  const q = url.indexOf('?');
  if (q < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Subset of SessionEvent the SSE writer needs. We avoid pulling the full
 * core type alias here because daemon.ts already treats events as opaque
 * records once they cross the wire.
 */
interface SessionEventLike { id: string; type: string }

function writeSse(res: ServerResponse, event: SessionEventLike): void {
  // Newlines inside `data` must be escaped per the SSE spec, but
  // JSON.stringify never produces literal newlines, so a single data line
  // is always safe.
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
