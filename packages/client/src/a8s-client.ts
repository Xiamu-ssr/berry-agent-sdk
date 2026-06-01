// ============================================================
// @berry-agent/client — A8sClient (canonical a8s HTTP client)
// ============================================================
// The one typed HTTP client over the a8s control-plane API. Every
// caller that drives a8s programmatically uses this: products (via
// AgentHandle below), the cluster-admin Hand, worker-daemon's
// label-injected tools, operator CLIs, monitoring.
//
// It supersedes the old a8s-admin A8sOperatorClient — that name is now a
// re-export of this class, so there is a single source of truth for "how
// to talk to a8s", not two drifting copies.
//
// Auth: a single bearer token (admin-scope for now). Every response is
// parsed through a cluster-protocol zod schema, so a drifted server
// surfaces as a schema error rather than a silently-typed `any`.

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  agentLocationSchema,
  createAgentRequestSchema,
  createAgentResponseSchema,
  listAgentsResponseSchema,
  operatorClusterReportSchema,
  operatorJoinScriptRequestSchema,
  operatorJoinScriptResponseSchema,
  operatorLeaseListResponseSchema,
  operatorMachineJoinScriptRequestSchema,
  operatorMachineJoinScriptResponseSchema,
  operatorMachineListResponseSchema,
  operatorOkResponseSchema,
  operatorWorkerListResponseSchema,
  machineExecReplySchema,
  machineExecRequestSchema,
  machineMcpInvokeReplySchema,
  machineMcpInvokeRequestSchema,
  machineMcpManifestSchema,
  sendRequestSchema,
  sendResponseSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  agentHomeReadResponseSchema,
  agentHomeWriteResponseSchema,
  agentSpecPatchResponseSchema,
  agentStatusResponseSchema,
  agentContextSizeResponseSchema,
  agentPauseResponseSchema,
  agentInterjectResponseSchema,
  type AgentHomeDoc,
  type AgentHomeReadResponse,
  type AgentHomeWriteResponse,
  type AgentSpecPatchRequest,
  type AgentSpecPatchResponse,
  type AgentStatusResponse,
  type AgentContextSizeResponse,
  type AgentPauseResponse,
  type AgentInterjectResponse,
  type AgentLocation,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type MachineExecReply,
  type MachineExecRequest,
  type MachineMcpInvokeReply,
  type MachineMcpInvokeRequest,
  type MachineMcpManifest,
  type OperatorClusterReport,
  type OperatorJoinScriptRequest,
  type OperatorJoinScriptResponse,
  type OperatorLeaseListResponse,
  type OperatorMachineJoinScriptRequest,
  type OperatorMachineJoinScriptResponse,
  type OperatorMachineListResponse,
  type OperatorWorkerListResponse,
  type SendRequest,
  type SendResponse,
  type SessionEventsResponse,
  type SessionListResponse,
} from '@berry-agent/cluster-protocol';

export interface A8sClientOptions {
  /** Base URL of a8s, e.g. http://localhost:8080 or https://a8s.example.com */
  a8sUrl: string;
  /**
   * Bearer token presented on every request. Admin-scope for now.
   * Either a string, or a function (sync/async) resolved per request —
   * the function form lets a product BFF inject a per-request/per-user
   * token without rebuilding the client.
   */
  token?: string | (() => string | Promise<string>);
  /**
   * Back-compat alias for `token` (the old A8sOperatorClient option name).
   * Exactly one of `token` / `adminToken` must be set.
   */
  adminToken?: string;
  /** Optional fetch override for tests. */
  fetch?: typeof fetch;
}

/** Thrown on any non-2xx a8s response, carrying status + body excerpt. */
export class A8sRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`a8s ${method} ${path} failed: HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'A8sRequestError';
  }
}

export class A8sClient {
  private readonly baseUrl: string;
  private readonly tokenSource: string | (() => string | Promise<string>);
  private readonly fetchImpl: typeof fetch;

  constructor(options: A8sClientOptions) {
    this.baseUrl = options.a8sUrl.replace(/\/$/, '');
    const token = options.token ?? options.adminToken;
    if (token === undefined) {
      throw new Error('A8sClient requires a token (or adminToken).');
    }
    this.tokenSource = token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Base URL (read-only) — products building SSE URLs need it. */
  get url(): string {
    return this.baseUrl;
  }

  /** The configured fetch (injected or global). AgentHandle's SSE uses it. */
  get fetchFn(): typeof fetch {
    return this.fetchImpl;
  }

  /** Resolve the bearer token (string or token-provider). */
  async authHeader(): Promise<string> {
    const token = typeof this.tokenSource === 'function' ? await this.tokenSource() : this.tokenSource;
    return adminAuthHeader(token);
  }

  // ----- Cluster overview -----

  clusterReport(): Promise<OperatorClusterReport> {
    return this.request('GET', A8S_PATHS.operatorCluster, operatorClusterReportSchema);
  }

  // ----- Workers -----

  listWorkers(): Promise<OperatorWorkerListResponse> {
    return this.request('GET', A8S_PATHS.operatorWorkers, operatorWorkerListResponseSchema);
  }

  async drainWorker(workerId: string): Promise<void> {
    await this.request('POST', A8S_PATHS.operatorWorkerDrain(workerId), operatorOkResponseSchema, {});
  }

  async undrainWorker(workerId: string): Promise<void> {
    await this.request('POST', A8S_PATHS.operatorWorkerUndrain(workerId), operatorOkResponseSchema, {});
  }

  async evictWorker(workerId: string): Promise<void> {
    await this.request('POST', A8S_PATHS.operatorWorkerEvict(workerId), operatorOkResponseSchema, {});
  }

  joinScript(input: OperatorJoinScriptRequest = {}): Promise<OperatorJoinScriptResponse> {
    return this.request(
      'POST', A8S_PATHS.operatorWorkerJoinScript, operatorJoinScriptResponseSchema,
      operatorJoinScriptRequestSchema.parse(input),
    );
  }

  // ----- Leases / agents -----

  listLeases(): Promise<OperatorLeaseListResponse> {
    return this.request('GET', A8S_PATHS.operatorLeases, operatorLeaseListResponseSchema);
  }

  listAgents(): Promise<ListAgentsResponse> {
    return this.request('GET', A8S_PATHS.agents, listAgentsResponseSchema);
  }

  /** Where is this agent assigned? `workerId` null when unscheduled/stranded. */
  agentLocation(agentId: string): Promise<AgentLocation> {
    return this.request('GET', A8S_PATHS.agent(agentId), agentLocationSchema);
  }

  /** Create a cluster agent. a8s scheduler picks the worker. */
  createAgent(input: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.request(
      'POST', A8S_PATHS.agents, createAgentResponseSchema,
      createAgentRequestSchema.parse(input),
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request('DELETE', A8S_PATHS.agent(agentId), operatorOkResponseSchema);
  }

  /** Send a turn to an agent and await its full turn result. */
  sendToAgent(agentId: string, input: SendRequest): Promise<SendResponse> {
    return this.request(
      'POST', A8S_PATHS.agentSend(agentId), sendResponseSchema,
      sendRequestSchema.parse(input),
    );
  }

  // ----- Session reads (product data plane) -----

  listSessions(agentId: string): Promise<SessionListResponse> {
    return this.request('GET', A8S_PATHS.agentSessions(agentId), sessionListResponseSchema);
  }

  /** Paginated session events (newest-last). `before` pages backward. */
  listSessionEvents(
    agentId: string,
    sessionId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<SessionEventsResponse> {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    const path = A8S_PATHS.agentSessionEvents(agentId, sessionId) + (qs ? `?${qs}` : '');
    return this.request('GET', path, sessionEventsResponseSchema);
  }

  // ----- Agent configuration & introspection (proxied to the worker) -----

  /** Read an agent home doc (memory / instructions / project-knowledge). */
  readAgentHome(agentId: string, doc: AgentHomeDoc): Promise<AgentHomeReadResponse> {
    return this.request('GET', A8S_PATHS.agentHomeDoc(agentId, doc), agentHomeReadResponseSchema);
  }

  /** Write an agent home doc. */
  writeAgentHome(agentId: string, doc: AgentHomeDoc, content: string): Promise<AgentHomeWriteResponse> {
    return this.request('PUT', A8S_PATHS.agentHomeDoc(agentId, doc), agentHomeWriteResponseSchema, { content });
  }

  /** Patch live spec fields (model / reasoning / toolDenylist). */
  patchAgentSpec(agentId: string, patch: AgentSpecPatchRequest): Promise<AgentSpecPatchResponse> {
    return this.request('PATCH', A8S_PATHS.agentSpec(agentId), agentSpecPatchResponseSchema, patch);
  }

  agentStatus(agentId: string): Promise<AgentStatusResponse> {
    return this.request('GET', A8S_PATHS.agentStatus(agentId), agentStatusResponseSchema);
  }

  agentContextSize(agentId: string, sessionId?: string): Promise<AgentContextSizeResponse> {
    const path = A8S_PATHS.agentContextSize(agentId) + (sessionId ? `?session=${encodeURIComponent(sessionId)}` : '');
    return this.request('GET', path, agentContextSizeResponseSchema);
  }

  pauseAgent(agentId: string, reason?: string): Promise<AgentPauseResponse> {
    return this.request('POST', A8S_PATHS.agentPause(agentId), agentPauseResponseSchema, { reason });
  }

  interjectAgent(agentId: string, text: string): Promise<AgentInterjectResponse> {
    return this.request('POST', A8S_PATHS.agentInterject(agentId), agentInterjectResponseSchema, { text });
  }

  // ----- Models template -----

  /** Raw models template GET (provider/model/tier config). */
  modelsTemplate(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorModelsTemplate);
  }

  // ----- Machines (machine layer) -----

  listMachines(): Promise<OperatorMachineListResponse> {
    return this.request('GET', A8S_PATHS.operatorMachines, operatorMachineListResponseSchema);
  }

  machineJoinScript(
    input: OperatorMachineJoinScriptRequest = {},
  ): Promise<OperatorMachineJoinScriptResponse> {
    return this.request(
      'POST', A8S_PATHS.operatorMachineJoinScript, operatorMachineJoinScriptResponseSchema,
      operatorMachineJoinScriptRequestSchema.parse(input),
    );
  }

  /** Run a command on a registered machine, brokered by a8s. */
  machineExec(machineId: string, input: MachineExecRequest): Promise<MachineExecReply> {
    return this.request(
      'POST', `/v1/machines/${encodeURIComponent(machineId)}/exec`, machineExecReplySchema,
      machineExecRequestSchema.parse(input),
    );
  }

  /** Invoke an MCP tool on a registered machine, brokered by a8s. */
  machineMcpInvoke(machineId: string, input: MachineMcpInvokeRequest): Promise<MachineMcpInvokeReply> {
    return this.request(
      'POST', `/v1/machines/${encodeURIComponent(machineId)}/mcp/invoke`, machineMcpInvokeReplySchema,
      machineMcpInvokeRequestSchema.parse(input),
    );
  }

  /** A machine's MCP tool manifest (for brain-side tool projection). */
  machineMcpManifest(machineId: string): Promise<MachineMcpManifest> {
    return this.request(
      'GET', `/v1/machines/${encodeURIComponent(machineId)}/mcp/manifest`, machineMcpManifestSchema,
    );
  }

  /** Open an ergonomic per-agent handle (send / sessions / events / SSE). */
  agent(agentId: string): AgentHandle {
    return new AgentHandle(this, agentId);
  }

  // ----- Internal -----

  /** One request → validated through a schema. The single fetch path. */
  private async request<T>(
    method: string,
    path: string,
    schema: { parse: (x: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    return schema.parse(await this.requestRaw(method, path, body));
  }

  /** One request → raw parsed JSON (for endpoints with no fixed schema). */
  private async requestRaw(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { [ADMIN_AUTH_HEADER]: await this.authHeader() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      throw new A8sRequestError(method, path, resp.status, await resp.text().catch(() => ''));
    }
    return resp.json();
  }
}

// Imported at the bottom to avoid a forward-reference in the class body.
import { AgentHandle } from './agent-handle.js';
