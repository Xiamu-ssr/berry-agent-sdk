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
  type SendStreamFrame,
  sessionEventsRequestSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
  agentSessionViewSchema,
  sessionCreateResponseSchema,
  sessionViewResponseSchema,
  sessionDeleteResponseSchema,
  sessionClearResponseSchema,
  sessionTodosResponseSchema,
  sessionAppendEventRequestSchema,
  sessionAppendEventResponseSchema,
  workerCapacityResponseSchema,
  workerHasAgentResponseSchema,
  workerRunAgentRequestSchema,
  workerRunAgentResponseSchema,
  workerStopAgentResponseSchema,
  healthResponseSchema,
  agentHomeDocSchema,
  agentHomeReadResponseSchema,
  agentHomeWriteRequestSchema,
  agentHomeWriteResponseSchema,
  agentSpecPatchRequestSchema,
  agentSpecPatchResponseSchema,
  agentStatusResponseSchema,
  agentSnapshotResponseSchema,
  skillInstallRequestSchema,
  skillInstallResponseSchema,
  skillRemoveResponseSchema,
  skillListResponseSchema,
  agentContextSizeResponseSchema,
  agentPauseRequestSchema,
  agentPauseResponseSchema,
  agentInterjectRequestSchema,
  agentInterjectResponseSchema,
  agentUsageResponseSchema,
  type AgentUsage,
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
  /**
   * Resolve an agent's consumption rollup from this worker's observe.db.
   * Returns the agent-level metrics, or null when nothing's been recorded
   * for it yet. Optional — when absent, GET /agents/:id/usage replies
   * `{present:false, usage:null}` so the read path degrades cleanly on
   * hosts that wire no observer.
   */
  usage?: (agentId: string) => AgentUsage | null;
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

    // Read the actually-bound port so `port: 0` (OS picks a free port
    // atomically) works — lets callers/tests skip the probe-then-bind race.
    const addr = this.server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    const callbackUrl = `http://${bindHost}:${boundPort}`;
    this.logger.log?.(`[worker-daemon] listening on ${callbackUrl}`);
    return { host: bindHost, port: boundPort, callbackUrl };
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

    // /agents/:id/sessions  &  /agents/:id/sessions/:sid/{events,clear,todos}  &  /agents/:id/sessions/:sid
    const sessionEventsMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/events(?:\?.*)?$/);
    if (sessionEventsMatch && req.method === 'GET') {
      return this.handleSessionEvents(
        decodeURIComponent(sessionEventsMatch[1]),
        decodeURIComponent(sessionEventsMatch[2]),
        req,
        res,
      );
    }
    if (sessionEventsMatch && req.method === 'POST') {
      return this.handleSessionAppendEvent(
        decodeURIComponent(sessionEventsMatch[1]),
        decodeURIComponent(sessionEventsMatch[2]),
        req,
        res,
      );
    }
    const sessionClearMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/clear$/);
    if (sessionClearMatch && req.method === 'POST') {
      return this.handleSessionClear(decodeURIComponent(sessionClearMatch[1]), decodeURIComponent(sessionClearMatch[2]), res);
    }
    const sessionTodosMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/todos(?:\?.*)?$/);
    if (sessionTodosMatch && req.method === 'GET') {
      return this.handleSessionTodos(decodeURIComponent(sessionTodosMatch[1]), decodeURIComponent(sessionTodosMatch[2]), res);
    }
    // /agents/:id/sessions/:sid  — GET one full view, DELETE remove
    const sessionOneMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions\/([^/]+)(?:\?.*)?$/);
    if (sessionOneMatch) {
      const aId = decodeURIComponent(sessionOneMatch[1]);
      const sId = decodeURIComponent(sessionOneMatch[2]);
      if (req.method === 'GET') return this.handleSessionView(aId, sId, req, res);
      if (req.method === 'DELETE') return this.handleSessionDelete(aId, sId, res);
    }
    const sessionListMatch = url.match(/^\/v1\/agents\/([^/]+)\/sessions(?:\?.*)?$/);
    if (sessionListMatch && req.method === 'GET') {
      return this.handleSessionList(decodeURIComponent(sessionListMatch[1]), res);
    }
    if (sessionListMatch && req.method === 'POST') {
      return this.handleSessionCreate(decodeURIComponent(sessionListMatch[1]), res);
    }

    // /agents/:id/usage — per-agent consumption rollup from observe.db
    const usageMatch = url.match(/^\/v1\/agents\/([^/]+)\/usage(?:\?.*)?$/);
    if (usageMatch && req.method === 'GET') {
      return this.handleAgentUsage(decodeURIComponent(usageMatch[1]), res);
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

    // /agents/:id/home/:doc  (GET read, PUT write)
    const homeMatch = url.match(/^\/v1\/agents\/([^/]+)\/home\/([^/]+)$/);
    if (homeMatch) {
      const agentId = decodeURIComponent(homeMatch[1]);
      const doc = decodeURIComponent(homeMatch[2]);
      if (req.method === 'GET') return this.handleHomeRead(agentId, doc, res);
      if (req.method === 'PUT') return this.handleHomeWrite(agentId, doc, req, res);
    }

    // /agents/:id/skills/:name  (DELETE remove one)
    const skillOneMatch = url.match(/^\/v1\/agents\/([^/]+)\/skills\/([^/]+)$/);
    if (skillOneMatch && req.method === 'DELETE') {
      return this.handleSkillRemove(decodeURIComponent(skillOneMatch[1]), decodeURIComponent(skillOneMatch[2]), res);
    }
    // /agents/:id/skills  (GET list, POST install)
    const skillsMatch = url.match(/^\/v1\/agents\/([^/]+)\/skills$/);
    if (skillsMatch) {
      const agentId = decodeURIComponent(skillsMatch[1]);
      if (req.method === 'GET') return this.handleSkillList(agentId, res);
      if (req.method === 'POST') return this.handleSkillInstall(agentId, req, res);
    }

    // /agents/:id/{spec,status,snapshot,context-size,pause,interject}
    const configMatch = url.match(/^\/v1\/agents\/([^/]+)\/(spec|status|snapshot|context-size|pause|interject)$/);
    if (configMatch) {
      const agentId = decodeURIComponent(configMatch[1]);
      const action = configMatch[2];
      if (action === 'spec' && req.method === 'PATCH') return this.handleSpecPatch(agentId, req, res);
      if (action === 'status' && req.method === 'GET') return this.handleStatus(agentId, res);
      if (action === 'snapshot' && req.method === 'GET') return this.handleSnapshot(agentId, res);
      if (action === 'context-size' && req.method === 'GET') return this.handleContextSize(agentId, req, res);
      if (action === 'pause' && req.method === 'POST') return this.handlePause(agentId, req, res);
      if (action === 'interject' && req.method === 'POST') return this.handleInterject(agentId, req, res);
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
    // Idempotent: if the agent is already mounted (e.g. the worker recovered
    // it from a disk scan on startup, and a8s now also asks us to run it),
    // the desired end-state — "agent running here" — already holds. Return ok
    // instead of throwing "already mounted", so the two convergence paths
    // (worker self-recovery + a8s createAgent) don't race into an error.
    if (this.worker.has(agentId)) {
      return writeJson(res, 200, workerRunAgentResponseSchema.parse({ ok: true }));
    }
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

    // Stream the turn as SSE: live AgentEvents during the turn, then a
    // terminal `done` (final result) or `error` frame. This is the single
    // output path for token-level increments — the durable /events/stream
    // only carries replayable SessionEvents and must not see ephemeral
    // deltas. One turn = one stream = one source of truth.
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const writeFrame = (frame: SendStreamFrame): void => {
      if (res.writableEnded) return;
      res.write(`event: ${frame.type}\n`);
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    let aborted = false;
    const onAbort = (): void => { aborted = true; };
    req.on('close', onAbort);
    req.on('aborted', onAbort);

    try {
      const result = await mount.runtime.send(
        parsed.prompt as Parameters<typeof mount.runtime.send>[0],
        {
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          requestId: parsed.requestId,
          onEvent: (event: unknown) => {
            if (aborted) return;
            writeFrame({ type: 'event', event: event as Record<string, unknown> });
          },
        },
      );
      writeFrame({
        type: 'done',
        response: {
          sessionId: result.sessionId,
          result: result as unknown as Record<string, unknown>,
        },
      });
    } catch (err) {
      writeFrame({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!res.writableEnded) res.end();
    }
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

  // ----- Agent configuration & introspection (D1) -----
  // Each delegates to the live ManagedAgentRuntime (same object AgentSession
  // wraps in-process). a8s proxies these verbatim; the BFF never sees the
  // runtime, only these HTTP shapes.

  /** Resolve a mount or write a 404 and return undefined. */
  private mountOr404(agentId: string, res: ServerResponse): ReturnType<Worker<TEntry>['get']> | undefined {
    const mount = this.worker.get(agentId);
    if (!mount) {
      writeJson(res, 404, errorPayloadSchema.parse({
        error: { code: 'agent_not_mounted', message: `agent "${agentId}" is not running on this worker` },
      }));
      return undefined;
    }
    return mount;
  }

  private async handleHomeRead(agentId: string, docRaw: string, res: ServerResponse): Promise<void> {
    const doc = agentHomeDocSchema.parse(docRaw);
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    if (doc === 'memory') {
      const r = await mount.runtime.readMemory();
      writeJson(res, 200, agentHomeReadResponseSchema.parse({ doc, path: r.path, content: r.content }));
    } else if (doc === 'instructions') {
      const r = await mount.runtime.readInstructions();
      writeJson(res, 200, agentHomeReadResponseSchema.parse({ doc, path: r.path, content: r.content }));
    } else {
      const r = await mount.runtime.readProjectKnowledge();
      const content = r.files.map((f) => `# ${f.path}\n${f.content}`).join('\n\n');
      writeJson(res, 200, agentHomeReadResponseSchema.parse({
        doc, path: null, content, files: r.files, project: r.project,
      }));
    }
  }

  private async handleHomeWrite(agentId: string, docRaw: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const doc = agentHomeDocSchema.parse(docRaw);
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const { content } = agentHomeWriteRequestSchema.parse(await readJson(req));
    let result: { path: string; bytes: number };
    if (doc === 'memory') result = await mount.runtime.writeMemory(content);
    else if (doc === 'instructions') result = await mount.runtime.writeInstructions(content);
    else {
      const r = await mount.runtime.writeProjectKnowledge(content);
      result = { path: r.path, bytes: r.bytes };
    }
    writeJson(res, 200, agentHomeWriteResponseSchema.parse(result));
  }

  private async handleSpecPatch(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const patch = agentSpecPatchRequestSchema.parse(await readJson(req));
    if (patch.model !== undefined) await mount.runtime.switchModel(patch.model);
    if (patch.reasoningEffort !== undefined) {
      mount.runtime.setReasoningEffort(patch.reasoningEffort as Parameters<typeof mount.runtime.setReasoningEffort>[0]);
    }
    if (patch.toolDenylist !== undefined) mount.runtime.setToolDenylist(patch.toolDenylist);
    if (patch.hands !== undefined) await mount.runtime.setBuiltinHands(patch.hands);
    writeJson(res, 200, agentSpecPatchResponseSchema.parse({ ok: true }));
  }

  private async handleStatus(agentId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const s = mount.runtime.getStatus();
    writeJson(res, 200, agentStatusResponseSchema.parse({ status: s.status, detail: s.detail }));
  }

  private handleSnapshot(agentId: string, res: ServerResponse): void {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const snap = mount.runtime.snapshot();
    writeJson(res, 200, agentSnapshotResponseSchema.parse({
      model: snap.provider.model,
      provider: snap.provider.type,
      status: snap.status,
      statusDetail: snap.statusDetail,
      hands: snap.hands.map((h) => ({
        id: h.id,
        kind: h.kind,
        displayName: h.displayName,
        capabilities: h.capabilities,
      })),
      skills: snap.skills.map((s) => ({ name: s.name, description: s.description })),
      tools: snap.tools.map((t) => t.name),
    }));
  }

  private async handleSkillList(agentId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const names = await mount.runtime.listInstalledSkills();
    writeJson(res, 200, skillListResponseSchema.parse({ names }));
  }

  private async handleSkillInstall(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const input = skillInstallRequestSchema.parse(await readJson(req));
    await mount.runtime.installSkill(input);
    writeJson(res, 200, skillInstallResponseSchema.parse({ ok: true, name: input.name }));
  }

  private async handleSkillRemove(agentId: string, name: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const removed = await mount.runtime.removeSkill(name);
    writeJson(res, 200, skillRemoveResponseSchema.parse({ removed }));
  }

  private async handleContextSize(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const sessionId = parseQuery(req.url ?? '').session || undefined;
    const c = await mount.runtime.contextSize(sessionId);
    writeJson(res, 200, agentContextSizeResponseSchema.parse({ current: c.current, window: c.window }));
  }

  private async handlePause(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const { reason } = agentPauseRequestSchema.parse(await readJson(req));
    const paused = mount.runtime.pause(reason);
    const s = mount.runtime.getStatus();
    writeJson(res, 200, agentPauseResponseSchema.parse({ paused, status: s.status, detail: s.detail }));
  }

  private async handleInterject(agentId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const { text } = agentInterjectRequestSchema.parse(await readJson(req));
    mount.runtime.interject(text);
    const s = mount.runtime.getStatus();
    writeJson(res, 200, agentInterjectResponseSchema.parse({ status: s.status, detail: s.detail }));
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

  /**
   * GET /agents/:id/usage — the agent's consumption rollup straight from
   * this worker's observe.db. Unlike the session routes this does NOT
   * require the agent to be currently mounted: usage is historical, keyed
   * by agentId in the observe store, so a stopped agent still reports what
   * it spent. Degrades to {present:false} when the host wired no resolver.
   */
  private handleAgentUsage(agentId: string, res: ServerResponse): void {
    if (!this.options.usage) {
      writeJson(res, 200, agentUsageResponseSchema.parse({ present: false, usage: null }));
      return;
    }
    const usage = this.options.usage(agentId);
    writeJson(res, 200, agentUsageResponseSchema.parse({ present: usage !== null, usage }));
  }


  /** Map a full AgentSessionView → the opaque wire shape. */
  private toSessionViewWire(v: {
    id: string; title?: string; createdAt: number; lastActiveAt: number;
    agentId?: string; status: string; messages: unknown[];
  }): unknown {
    return agentSessionViewSchema.parse({
      id: v.id,
      title: v.title,
      createdAt: v.createdAt,
      lastActiveAt: v.lastActiveAt,
      agentId: v.agentId,
      status: v.status,
      messages: v.messages as Record<string, unknown>[],
    });
  }

  private async handleSessionCreate(agentId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const view = await mount.runtime.createSession();
    writeJson(res, 200, sessionCreateResponseSchema.parse({ session: this.toSessionViewWire(view) }));
  }

  private async handleSessionView(
    agentId: string, sessionId: string, req: IncomingMessage, res: ServerResponse,
  ): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    // ?activate=false reads the view without switching the active session
    // (products inspecting a historical session must not steal focus).
    const params = parseQuery(req.url ?? '');
    const activate = params.activate !== 'false';
    const view = await mount.runtime.loadSessionView(sessionId, { activate });
    writeJson(res, 200, sessionViewResponseSchema.parse({
      session: view ? this.toSessionViewWire(view) : null,
    }));
  }

  private async handleSessionAppendEvent(
    agentId: string, sessionId: string, req: IncomingMessage, res: ServerResponse,
  ): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const { event } = sessionAppendEventRequestSchema.parse(await readJson(req));
    const persisted = await mount.runtime.appendSessionEvent(
      sessionId,
      event as Parameters<typeof mount.runtime.appendSessionEvent>[1],
    );
    writeJson(res, 200, sessionAppendEventResponseSchema.parse({
      event: persisted as Record<string, unknown> | null,
    }));
  }

  private async handleSessionDelete(agentId: string, sessionId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const result = await mount.runtime.deleteSession(sessionId);
    writeJson(res, 200, sessionDeleteResponseSchema.parse({
      sessionId: result.sessionId, wasActive: result.wasActive,
    }));
  }

  private async handleSessionClear(agentId: string, sessionId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const result = await mount.runtime.clearSession(sessionId);
    writeJson(res, 200, sessionClearResponseSchema.parse({
      sessionId: result.sessionId,
      session: result.view ? this.toSessionViewWire(result.view) : null,
    }));
  }

  private async handleSessionTodos(agentId: string, sessionId: string, res: ServerResponse): Promise<void> {
    const mount = this.mountOr404(agentId, res);
    if (!mount) return;
    const todos = await mount.runtime.getTodos(sessionId);
    writeJson(res, 200, sessionTodosResponseSchema.parse({ todos }));
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
