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
  modelsTemplateGetResponseSchema,
  modelsTemplatePutRequestSchema,
  modelsPresetListResponseSchema,
  modelsProbeRequestSchema,
  modelsProbeResponseSchema,
  machineExecReplySchema,
  machineExecRequestSchema,
  machineMcpInvokeReplySchema,
  machineMcpInvokeRequestSchema,
  machineMcpManifestSchema,
  sendRequestSchema,
  sendStreamFrameSchema,
  sessionEventsResponseSchema,
  sessionListResponseSchema,
  sessionCreateResponseSchema,
  sessionViewResponseSchema,
  sessionDeleteResponseSchema,
  sessionClearResponseSchema,
  sessionTodosResponseSchema,
  sessionAppendEventResponseSchema,
  agentHomeReadResponseSchema,
  agentHomeWriteResponseSchema,
  agentSpecPatchResponseSchema,
  agentStatusResponseSchema,
  agentSnapshotResponseSchema,
  skillInstallResponseSchema,
  skillRemoveResponseSchema,
  skillListResponseSchema,
  agentContextSizeResponseSchema,
  agentPauseResponseSchema,
  agentInterjectResponseSchema,
  agentUsageResponseSchema,
  operatorUsageResponseSchema,
  usageSessionListResponseSchema,
  usageTurnListResponseSchema,
  usageInferenceListResponseSchema,
  usageInferenceDetailResponseSchema,
  worklistResponseSchema,
  worklistTaskSchema,
  teamMessagesResponseSchema,
  teamMessageSchema,
  type AgentHomeDoc,
  type AgentHomeReadResponse,
  type AgentHomeWriteResponse,
  type AgentSpecPatchRequest,
  type AgentSpecPatchResponse,
  type AgentStatusResponse,
  type AgentSnapshotResponse,
  type SkillInstallRequest,
  type SkillInstallResponse,
  type SkillRemoveResponse,
  type SkillListResponse,
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
  type ModelsTemplate,
  type ModelsTemplateGetResponse,
  type ModelsPresetListResponse,
  type ModelsProbeRequest,
  type ModelsProbeResponse,
  type SendRequest,
  type SendResponse,
  type SessionEventsResponse,
  type SessionListResponse,
  type SessionCreateResponse,
  type SessionViewResponse,
  type SessionAppendEventResponse,
  type SessionDeleteResponse,
  type SessionClearResponse,
  type SessionTodosResponse,
  type AgentUsageResponse,
  type OperatorUsageResponse,
  type UsageSessionListResponse,
  type UsageTurnListResponse,
  type UsageInferenceListResponse,
  type UsageInferenceDetailResponse,
  type WorklistResponse,
  type WorklistTask,
  type WorklistCreateRequest,
  type WorklistPatchRequest,
  type TeamMessagesResponse,
  type TeamMessage,
  type TeamMessageAppendRequest,
  handRecipeListResponseSchema,
  type HandRecipeListResponse,
  handRecipeRegisterRequestSchema,
  type HandRecipeRegisterRequest,
  type HandRecipe,
  handRecipeSchema,
  operatorSkillListResponseSchema,
  operatorSkillDetailSchema,
  operatorSkillRegisterRequestSchema,
  operatorSkillInstallResponseSchema,
  type OperatorSkillListResponse,
  type OperatorSkillDetail,
  type OperatorSkillRegisterRequest,
  type OperatorSkillInstallResponse,
  productCredentialListResponseSchema,
  productCredentialIssueRequestSchema,
  productCredentialIssueResponseSchema,
  type ProductCredentialListResponse,
  type ProductCredentialIssueRequest,
  type ProductCredentialIssueResponse,
  scopedTokenIssueRequestSchema,
  scopedTokenIssueResponseSchema,
  type ScopedTokenIssueRequest,
  type ScopedTokenIssueResponse,
  auditQueryResponseSchema,
  type AuditQueryResponse,
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
    // Native `fetch` must keep its receiver: browsers throw "Illegal
    // invocation" if `window.fetch` is called as a method on another object
    // (which is what `this.fetchImpl(...)` does). Bind the global to its realm;
    // an injected fetch is used as-is (callers own its binding).
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
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

  /**
   * Send a turn to an agent. The turn streams back as SSE: live AgentEvents
   * (text_delta, tool_call, …) are delivered to `onEvent` as they happen,
   * and the promise resolves with the final SendResponse. This is the only
   * path for token-level increments (the durable event stream stays
   * replayable and never carries ephemeral deltas).
   */
  async sendToAgent(
    agentId: string,
    input: SendRequest,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<SendResponse> {
    const headers: Record<string, string> = {
      [ADMIN_AUTH_HEADER]: await this.authHeader(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    const resp = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.agentSend(agentId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sendRequestSchema.parse(input)),
    });
    if (!resp.ok || !resp.body) {
      throw new A8sRequestError('POST', A8S_PATHS.agentSend(agentId), resp.status, await resp.text().catch(() => ''));
    }
    let final: SendResponse | undefined;
    for await (const frame of streamSseFrames(resp.body)) {
      const parsed = sendStreamFrameSchema.parse(frame.data);
      if (parsed.type === 'event') onEvent?.(parsed.event);
      else if (parsed.type === 'done') final = parsed.response;
      else throw new Error(`agent turn failed: ${parsed.message}`);
    }
    if (!final) throw new Error('agent turn stream ended without a result');
    return final;
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

  // ----- Session write ops (D-sessions, proxied to the worker) -----

  /** Create a fresh session; returns its full view. */
  createSession(agentId: string): Promise<SessionCreateResponse> {
    return this.request('POST', A8S_PATHS.agentSessions(agentId), sessionCreateResponseSchema, {});
  }

  /** Load one session's full view (with rendered messages); null if absent.
   *  `activate: false` reads without switching the agent's active session. */
  getSession(agentId: string, sessionId: string, opts: { activate?: boolean } = {}): Promise<SessionViewResponse> {
    const path = A8S_PATHS.agentSession(agentId, sessionId)
      + (opts.activate === false ? '?activate=false' : '');
    return this.request('GET', path, sessionViewResponseSchema);
  }

  /** Append an event draft to a session's durable log (e.g. approval
   *  request/decision). Returns the persisted event, or null. */
  appendSessionEvent(agentId: string, sessionId: string, event: Record<string, unknown>): Promise<SessionAppendEventResponse> {
    return this.request(
      'POST', A8S_PATHS.agentSessionEvents(agentId, sessionId), sessionAppendEventResponseSchema, { event },
    );
  }

  /** Delete a session; reports whether it was the active one. */
  deleteSession(agentId: string, sessionId: string): Promise<SessionDeleteResponse> {
    return this.request('DELETE', A8S_PATHS.agentSession(agentId, sessionId), sessionDeleteResponseSchema);
  }

  /** Clear a session's history; returns the (possibly fresh) view. */
  clearSession(agentId: string, sessionId: string): Promise<SessionClearResponse> {
    return this.request('POST', A8S_PATHS.agentSessionClear(agentId, sessionId), sessionClearResponseSchema, {});
  }

  /** Read a session's todo items. */
  getSessionTodos(agentId: string, sessionId: string): Promise<SessionTodosResponse> {
    return this.request('GET', A8S_PATHS.agentSessionTodos(agentId, sessionId), sessionTodosResponseSchema);
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

  /** Patch live spec fields (model / reasoning / toolDenylist / hands). */
  patchAgentSpec(agentId: string, patch: AgentSpecPatchRequest): Promise<AgentSpecPatchResponse> {
    return this.request('PATCH', A8S_PATHS.agentSpec(agentId), agentSpecPatchResponseSchema, patch);
  }

  agentStatus(agentId: string): Promise<AgentStatusResponse> {
    return this.request('GET', A8S_PATHS.agentStatus(agentId), agentStatusResponseSchema);
  }

  /** Product-facing agent snapshot: Hands (4+1-native), skills, tools, model. */
  agentSnapshot(agentId: string): Promise<AgentSnapshotResponse> {
    return this.request('GET', A8S_PATHS.agentSnapshot(agentId), agentSnapshotResponseSchema);
  }

  /** Installed skill names for an agent (index meta comes via agentSnapshot). */
  listSkills(agentId: string): Promise<SkillListResponse> {
    return this.request('GET', A8S_PATHS.agentSkills(agentId), skillListResponseSchema);
  }

  /** Install a skill into the agent's home (content provided by caller). */
  installSkill(agentId: string, input: SkillInstallRequest): Promise<SkillInstallResponse> {
    return this.request('POST', A8S_PATHS.agentSkills(agentId), skillInstallResponseSchema, input);
  }

  /** Remove a skill from the agent's home. */
  removeSkill(agentId: string, name: string): Promise<SkillRemoveResponse> {
    return this.request('DELETE', A8S_PATHS.agentSkill(agentId, name), skillRemoveResponseSchema);
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

  // ----- Usage / observability (read-only; workers' observe.db via a8s) -----

  /** Cluster-wide usage rollup (totals + byProduct + byModel + trend + agent rows). Admin-scope. */
  operatorUsage(): Promise<OperatorUsageResponse> {
    return this.request('GET', A8S_PATHS.operatorUsage, operatorUsageResponseSchema);
  }

  /** One agent's usage summary (cost/tokens/tools/model breakdown/daily trend). */
  agentUsage(agentId: string): Promise<AgentUsageResponse> {
    return this.request('GET', A8S_PATHS.agentUsage(agentId), agentUsageResponseSchema);
  }

  /** Drilldown L1: the agent's sessions with per-session cost + counts. */
  agentUsageSessions(agentId: string): Promise<UsageSessionListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageSessions(agentId), usageSessionListResponseSchema);
  }

  /** Drilldown L2: the engine-loop turns inside a session. */
  agentUsageTurns(agentId: string, sessionId: string): Promise<UsageTurnListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageTurns(agentId, sessionId), usageTurnListResponseSchema);
  }

  /** Drilldown L3: the inferences (LLM calls) inside a turn. */
  agentUsageInferences(agentId: string, turnId: string): Promise<UsageInferenceListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageInferences(agentId, turnId), usageInferenceListResponseSchema);
  }

  /** Drilldown L4: one inference's full detail (request/response wire, tool calls, guards). */
  agentUsageInferenceDetail(agentId: string, inferenceId: string): Promise<UsageInferenceDetailResponse> {
    return this.request('GET', A8S_PATHS.agentUsageInferenceDetail(agentId, inferenceId), usageInferenceDetailResponseSchema);
  }

  // ----- Team (project-scoped worklist + message log; emergent team) -----

  /** Read a project's worklist. */
  listWorklist(project: string): Promise<WorklistResponse> {
    return this.request('GET', A8S_PATHS.projectWorklist(project), worklistResponseSchema);
  }

  /** Add a worklist task (server stamps id/status/timestamps). */
  addWorklistTask(project: string, req: WorklistCreateRequest): Promise<WorklistTask> {
    return this.request('POST', A8S_PATHS.projectWorklist(project), worklistTaskSchema, req);
  }

  /** Patch a worklist task (claim / status / assignee). */
  patchWorklistTask(project: string, taskId: string, patch: WorklistPatchRequest): Promise<WorklistTask> {
    return this.request('PATCH', A8S_PATHS.projectWorklistTask(project, taskId), worklistTaskSchema, patch);
  }

  /** Read a project's team message log. */
  listTeamMessages(project: string): Promise<TeamMessagesResponse> {
    return this.request('GET', A8S_PATHS.projectMessages(project), teamMessagesResponseSchema);
  }

  /** Append a message to a project's team log (server stamps id/ts). */
  appendTeamMessage(project: string, req: TeamMessageAppendRequest): Promise<TeamMessage> {
    return this.request('POST', A8S_PATHS.projectMessages(project), teamMessageSchema, req);
  }

  // ----- Models template -----

  /** Raw models template GET (provider/model/tier config). */
  modelsTemplate(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorModelsTemplate);
  }

  /** Typed models template GET. The template is the cluster's model config
   *  (providers/models/tiers) — a8s owns it; products read/write it here. */
  getModelsTemplate(): Promise<ModelsTemplateGetResponse> {
    return this.request('GET', A8S_PATHS.operatorModelsTemplate, modelsTemplateGetResponseSchema);
  }

  /** Replace the cluster models template. Workers pull it at register time. */
  putModelsTemplate(template: ModelsTemplate): Promise<void> {
    return this.request(
      'PUT', A8S_PATHS.operatorModelsTemplate, operatorOkResponseSchema,
      modelsTemplatePutRequestSchema.parse({ template }),
    ).then(() => undefined);
  }

  /** Built-in provider presets for the "add provider" UI. */
  modelsPresets(): Promise<ModelsPresetListResponse> {
    return this.request('GET', A8S_PATHS.operatorModelsPresets, modelsPresetListResponseSchema);
  }

  /** Pull a provider's live model list (a8s proxies; key never hits the browser). */
  probeModels(input: ModelsProbeRequest): Promise<ModelsProbeResponse> {
    return this.request(
      'POST', A8S_PATHS.operatorModelsProbe, modelsProbeResponseSchema,
      modelsProbeRequestSchema.parse(input),
    );
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

  // ----- Health -----

  async health(): Promise<{ ok: true; version?: string; uptime?: number }> {
    return this.requestRaw('GET', A8S_PATHS.health) as Promise<{ ok: true; version?: string; uptime?: number }>;
  }

  // ----- Operator: Hand recipes -----

  /** @operator List all Hand recipes (environment + tool bundles). */
  async listHandRecipes(): Promise<HandRecipeListResponse> {
    return this.request('GET', A8S_PATHS.operatorHandRecipes, handRecipeListResponseSchema);
  }

  /** @operator Register or update a Hand recipe. */
  async registerHandRecipe(input: HandRecipeRegisterRequest): Promise<HandRecipe> {
    return this.request('POST', A8S_PATHS.operatorHandRecipes, handRecipeSchema, handRecipeRegisterRequestSchema.parse(input));
  }

  /** @operator Delete a Hand recipe by ID. */
  async deleteHandRecipe(recipeId: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorHandRecipe(recipeId));
  }

  // ----- Operator: Skill registry -----

  /** List skill catalog (name + description, no content). Product tokens can call this. */
  async listRegistrySkills(): Promise<OperatorSkillListResponse> {
    return this.request('GET', A8S_PATHS.operatorSkills, operatorSkillListResponseSchema);
  }

  /** Get full skill content (SKILL.md + files). Product tokens can call this. */
  async getRegistrySkill(name: string): Promise<OperatorSkillDetail> {
    return this.request('GET', A8S_PATHS.operatorSkill(name), operatorSkillDetailSchema);
  }

  /** @operator Register or update a skill in the catalog. */
  async registerRegistrySkill(input: OperatorSkillRegisterRequest): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.operatorSkills, operatorSkillRegisterRequestSchema.parse(input));
  }

  /** @operator Remove a skill from the catalog. */
  async deleteRegistrySkill(name: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorSkill(name));
  }

  /** Install a catalog skill onto an agent (proxies to worker). Product tokens can call this. */
  async installRegistrySkillOnAgent(agentId: string, skillName: string): Promise<OperatorSkillInstallResponse> {
    return this.request('POST', A8S_PATHS.operatorAgentInstallSkill(agentId, skillName), operatorSkillInstallResponseSchema);
  }

  // ----- Operator: Credentials -----

  /** @operator List product credentials (metadata only, no token values). */
  async listCredentials(): Promise<ProductCredentialListResponse> {
    return this.request('GET', A8S_PATHS.operatorCredentials, productCredentialListResponseSchema);
  }

  /** @operator Issue or rotate a product credential (returns token value ONCE). */
  async issueCredential(input: ProductCredentialIssueRequest): Promise<ProductCredentialIssueResponse> {
    return this.request('POST', A8S_PATHS.operatorCredentials, productCredentialIssueResponseSchema, productCredentialIssueRequestSchema.parse(input));
  }

  /** @operator Revoke a product credential (cascade-revokes its subject tokens). */
  async revokeCredential(product: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorCredential(product));
  }

  /** Mint a subject-scoped token under a product. Requires the product's root token or admin. */
  async issueScopedToken(product: string, input: ScopedTokenIssueRequest): Promise<ScopedTokenIssueResponse> {
    return this.request('POST', A8S_PATHS.productScopedToken(product), scopedTokenIssueResponseSchema, scopedTokenIssueRequestSchema.parse(input));
  }

  // ----- Operator: Audit -----

  /** @operator Query the audit log (filters: from/to/action/outcome/limit). */
  async queryAudit(opts?: { from?: number; to?: number; action?: string; outcome?: string; limit?: number }): Promise<AuditQueryResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set('from', String(opts.from));
    if (opts?.to) params.set('to', String(opts.to));
    if (opts?.action) params.set('action', opts.action);
    if (opts?.outcome) params.set('outcome', opts.outcome);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request('GET', `${A8S_PATHS.operatorAudit}${qs ? `?${qs}` : ''}`, auditQueryResponseSchema);
  }

  // ----- Operator: Admin agent -----

  /** @operator Get the berry-admin agent's status. */
  async getAdminAgent(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorAdminAgent);
  }

  /** @operator Ensure berry-admin is scheduled on the cluster. */
  async ensureAdminAgent(opts?: Record<string, unknown>): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.operatorAdminAgent, opts);
  }

  // ----- Operator: Wakes -----

  /** @operator List the wake queue (pending/completed/failed). */
  async listWakes(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorWakes);
  }

  /** @operator Cancel a scheduled wake. */
  async cancelWake(wakeId: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorWakeCancel(wakeId));
  }

  // ----- Machine MCP config -----

  /** @operator Read a machine's .mcp.json (source of truth for its MCP servers). */
  async getMachineMcpConfig(machineId: string): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorMachineMcpConfig(machineId));
  }

  /** @operator Write a machine's .mcp.json (triggers install + reload). */
  async setMachineMcpConfig(machineId: string, config: unknown): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.operatorMachineMcpConfig(machineId), config);
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
import { AgentHandle, streamSseFrames } from './agent-handle.js';
