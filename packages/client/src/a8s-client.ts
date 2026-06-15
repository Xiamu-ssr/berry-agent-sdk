// ============================================================
// @berry-agent/client — A8sClient
// ============================================================
// The canonical typed HTTP client over the a8s control-plane API.
// Auth: bearer token (admin or product-scoped). Responses are validated
// through cluster-protocol zod schemas.

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
  a8sUrl: string;
  token: string | (() => string | Promise<string>);
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
    if (!options.token) throw new Error('A8sClient requires a token.');
    this.tokenSource = options.token;
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

  agentLocation(agentId: string): Promise<AgentLocation> {
    return this.request('GET', A8S_PATHS.agent(agentId), agentLocationSchema);
  }

  createAgent(input: CreateAgentRequest): Promise<CreateAgentResponse> {
    return this.request(
      'POST', A8S_PATHS.agents, createAgentResponseSchema,
      createAgentRequestSchema.parse(input),
    );
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request('DELETE', A8S_PATHS.agent(agentId), operatorOkResponseSchema);
  }

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

  // ----- Session writes -----

  createSession(agentId: string): Promise<SessionCreateResponse> {
    return this.request('POST', A8S_PATHS.agentSessions(agentId), sessionCreateResponseSchema, {});
  }

  getSession(agentId: string, sessionId: string, opts: { activate?: boolean } = {}): Promise<SessionViewResponse> {
    const path = A8S_PATHS.agentSession(agentId, sessionId)
      + (opts.activate === false ? '?activate=false' : '');
    return this.request('GET', path, sessionViewResponseSchema);
  }

  appendSessionEvent(agentId: string, sessionId: string, event: Record<string, unknown>): Promise<SessionAppendEventResponse> {
    return this.request(
      'POST', A8S_PATHS.agentSessionEvents(agentId, sessionId), sessionAppendEventResponseSchema, { event },
    );
  }

  deleteSession(agentId: string, sessionId: string): Promise<SessionDeleteResponse> {
    return this.request('DELETE', A8S_PATHS.agentSession(agentId, sessionId), sessionDeleteResponseSchema);
  }

  clearSession(agentId: string, sessionId: string): Promise<SessionClearResponse> {
    return this.request('POST', A8S_PATHS.agentSessionClear(agentId, sessionId), sessionClearResponseSchema, {});
  }

  getSessionTodos(agentId: string, sessionId: string): Promise<SessionTodosResponse> {
    return this.request('GET', A8S_PATHS.agentSessionTodos(agentId, sessionId), sessionTodosResponseSchema);
  }

  // ----- Agent config -----

  readAgentHome(agentId: string, doc: AgentHomeDoc): Promise<AgentHomeReadResponse> {
    return this.request('GET', A8S_PATHS.agentHomeDoc(agentId, doc), agentHomeReadResponseSchema);
  }

  writeAgentHome(agentId: string, doc: AgentHomeDoc, content: string): Promise<AgentHomeWriteResponse> {
    return this.request('PUT', A8S_PATHS.agentHomeDoc(agentId, doc), agentHomeWriteResponseSchema, { content });
  }

  patchAgentSpec(agentId: string, patch: AgentSpecPatchRequest): Promise<AgentSpecPatchResponse> {
    return this.request('PATCH', A8S_PATHS.agentSpec(agentId), agentSpecPatchResponseSchema, patch);
  }

  agentStatus(agentId: string): Promise<AgentStatusResponse> {
    return this.request('GET', A8S_PATHS.agentStatus(agentId), agentStatusResponseSchema);
  }

  agentSnapshot(agentId: string): Promise<AgentSnapshotResponse> {
    return this.request('GET', A8S_PATHS.agentSnapshot(agentId), agentSnapshotResponseSchema);
  }

  listSkills(agentId: string): Promise<SkillListResponse> {
    return this.request('GET', A8S_PATHS.agentSkills(agentId), skillListResponseSchema);
  }

  installSkill(agentId: string, input: SkillInstallRequest): Promise<SkillInstallResponse> {
    return this.request('POST', A8S_PATHS.agentSkills(agentId), skillInstallResponseSchema, input);
  }

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

  // ----- Usage -----

  usage(): Promise<OperatorUsageResponse> {
    return this.request('GET', A8S_PATHS.operatorUsage, operatorUsageResponseSchema);
  }

  agentUsage(agentId: string): Promise<AgentUsageResponse> {
    return this.request('GET', A8S_PATHS.agentUsage(agentId), agentUsageResponseSchema);
  }

  agentUsageSessions(agentId: string): Promise<UsageSessionListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageSessions(agentId), usageSessionListResponseSchema);
  }

  agentUsageTurns(agentId: string, sessionId: string): Promise<UsageTurnListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageTurns(agentId, sessionId), usageTurnListResponseSchema);
  }

  agentUsageInferences(agentId: string, turnId: string): Promise<UsageInferenceListResponse> {
    return this.request('GET', A8S_PATHS.agentUsageInferences(agentId, turnId), usageInferenceListResponseSchema);
  }

  agentUsageInferenceDetail(agentId: string, inferenceId: string): Promise<UsageInferenceDetailResponse> {
    return this.request('GET', A8S_PATHS.agentUsageInferenceDetail(agentId, inferenceId), usageInferenceDetailResponseSchema);
  }

  // ----- Team -----

  listWorklist(project: string): Promise<WorklistResponse> {
    return this.request('GET', A8S_PATHS.projectWorklist(project), worklistResponseSchema);
  }

  addWorklistTask(project: string, req: WorklistCreateRequest): Promise<WorklistTask> {
    return this.request('POST', A8S_PATHS.projectWorklist(project), worklistTaskSchema, req);
  }

  patchWorklistTask(project: string, taskId: string, patch: WorklistPatchRequest): Promise<WorklistTask> {
    return this.request('PATCH', A8S_PATHS.projectWorklistTask(project, taskId), worklistTaskSchema, patch);
  }

  listTeamMessages(project: string): Promise<TeamMessagesResponse> {
    return this.request('GET', A8S_PATHS.projectMessages(project), teamMessagesResponseSchema);
  }

  appendTeamMessage(project: string, req: TeamMessageAppendRequest): Promise<TeamMessage> {
    return this.request('POST', A8S_PATHS.projectMessages(project), teamMessageSchema, req);
  }

  // ----- Models -----

  getModelsTemplate(): Promise<ModelsTemplateGetResponse> {
    return this.request('GET', A8S_PATHS.catalogModelsTemplate, modelsTemplateGetResponseSchema);
  }

  putModelsTemplate(template: ModelsTemplate): Promise<void> {
    return this.request(
      'PUT', A8S_PATHS.catalogModelsTemplate, operatorOkResponseSchema,
      modelsTemplatePutRequestSchema.parse({ template }),
    ).then(() => undefined);
  }

  modelsPresets(): Promise<ModelsPresetListResponse> {
    return this.request('GET', A8S_PATHS.catalogModelsPresets, modelsPresetListResponseSchema);
  }

  probeModels(input: ModelsProbeRequest): Promise<ModelsProbeResponse> {
    return this.request(
      'POST', A8S_PATHS.catalogModelsProbe, modelsProbeResponseSchema,
      modelsProbeRequestSchema.parse(input),
    );
  }

  // ----- Machines -----

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

  machineExec(machineId: string, input: MachineExecRequest): Promise<MachineExecReply> {
    return this.request(
      'POST', A8S_PATHS.machineExec(machineId), machineExecReplySchema,
      machineExecRequestSchema.parse(input),
    );
  }

  machineMcpInvoke(machineId: string, input: MachineMcpInvokeRequest): Promise<MachineMcpInvokeReply> {
    return this.request(
      'POST', A8S_PATHS.machineMcpInvoke(machineId), machineMcpInvokeReplySchema,
      machineMcpInvokeRequestSchema.parse(input),
    );
  }

  machineMcpManifest(machineId: string): Promise<MachineMcpManifest> {
    return this.request('GET', A8S_PATHS.machineMcpManifest(machineId), machineMcpManifestSchema);
  }

  agent(agentId: string): AgentHandle {
    return new AgentHandle(this, agentId);
  }

  // ----- Health -----

  async health(): Promise<{ ok: true; version: string; apiVersion: number; uptime: number }> {
    return this.requestRaw('GET', A8S_PATHS.health) as Promise<{ ok: true; version: string; apiVersion: number; uptime: number }>;
  }

  // ----- Operator: Hand recipes -----

  async listHandRecipes(): Promise<HandRecipeListResponse> {
    return this.request('GET', A8S_PATHS.catalogHandRecipes, handRecipeListResponseSchema);
  }

  async registerHandRecipe(input: HandRecipeRegisterRequest): Promise<HandRecipe> {
    return this.request('POST', A8S_PATHS.catalogHandRecipes, handRecipeSchema, handRecipeRegisterRequestSchema.parse(input));
  }

  async deleteHandRecipe(recipeId: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorHandRecipe(recipeId));
  }

  // ----- Operator: Skill registry -----

  async listRegistrySkills(): Promise<OperatorSkillListResponse> {
    return this.request('GET', A8S_PATHS.catalogSkills, operatorSkillListResponseSchema);
  }

  async getRegistrySkill(name: string): Promise<OperatorSkillDetail> {
    return this.request('GET', A8S_PATHS.catalogSkill(name), operatorSkillDetailSchema);
  }

  async registerRegistrySkill(input: OperatorSkillRegisterRequest): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.catalogSkills, operatorSkillRegisterRequestSchema.parse(input));
  }

  async deleteRegistrySkill(name: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.catalogSkill(name));
  }

  async installRegistrySkillOnAgent(agentId: string, skillName: string): Promise<OperatorSkillInstallResponse> {
    return this.request('POST', A8S_PATHS.catalogInstallSkill(agentId, skillName), operatorSkillInstallResponseSchema);
  }

  // ----- Operator: Credentials -----

  async listCredentials(): Promise<ProductCredentialListResponse> {
    return this.request('GET', A8S_PATHS.operatorCredentials, productCredentialListResponseSchema);
  }

  async issueCredential(input: ProductCredentialIssueRequest): Promise<ProductCredentialIssueResponse> {
    return this.request('POST', A8S_PATHS.operatorCredentials, productCredentialIssueResponseSchema, productCredentialIssueRequestSchema.parse(input));
  }

  async revokeCredential(product: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorCredential(product));
  }

  async issueScopedToken(product: string, input: ScopedTokenIssueRequest): Promise<ScopedTokenIssueResponse> {
    return this.request('POST', A8S_PATHS.productScopedToken(product), scopedTokenIssueResponseSchema, scopedTokenIssueRequestSchema.parse(input));
  }

  // ----- Operator: Audit -----

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

  async getAdminAgent(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorAdminAgent);
  }

  async ensureAdminAgent(opts?: Record<string, unknown>): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.operatorAdminAgent, opts);
  }

  // ----- Operator: Wakes -----

  async listWakes(): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorWakes);
  }

  async cancelWake(wakeId: string): Promise<void> {
    await this.requestRaw('DELETE', A8S_PATHS.operatorWakeCancel(wakeId));
  }

  // ----- Machine MCP config -----

  async getMachineMcpConfig(machineId: string): Promise<unknown> {
    return this.requestRaw('GET', A8S_PATHS.operatorMachineMcpConfig(machineId));
  }

  async setMachineMcpConfig(machineId: string, config: unknown): Promise<unknown> {
    return this.requestRaw('POST', A8S_PATHS.operatorMachineMcpConfig(machineId), config);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: { parse: (x: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    return schema.parse(await this.requestRaw(method, path, body));
  }

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
