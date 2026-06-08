// ============================================================
// API types & TanStack Query hooks
// ============================================================
//
// One file with all queries + types. Small enough that a single
// import surface is more useful than scattering query keys across
// pages.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

// ---- Cluster ----

export interface ClusterReport {
  workerCount: { total: number; active: number; draining: number; evicted: number };
  capacity: { total: number; used: number; available: number };
  agentCount: number;
  uptimeSeconds: number;
}
export function useCluster() {
  return useQuery({
    queryKey: ['cluster'],
    queryFn: () => api<ClusterReport>('/v1/operator/cluster'),
    refetchInterval: 5000,
  });
}

// ---- Workers ----

export interface Worker {
  workerId: string;
  state: 'active' | 'draining' | 'evicted' | 'withdrawn';
  capacity: number;
  used: number;
  callbackUrl: string;
  labels?: Record<string, string>;
  registeredAt: number;
  heartbeatAt: number;
  heartbeatExpiresAt: number;
  drainedAt?: number;
  evictedAt?: number;
  withdrawnAt?: number;
}
export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: () => api<{ workers: Worker[] }>('/v1/operator/workers').then((r) => r.workers),
    refetchInterval: 5000,
  });
}

export function useWorkerAction(action: 'drain' | 'undrain' | 'evict') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      api(`/v1/operator/workers/${encodeURIComponent(workerId)}/${action}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workers'] });
      void qc.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}

export function useJoinScript() {
  return useMutation({
    mutationFn: (input: { workerId?: string; capacity?: number; port?: number } = {}) =>
      api<{ script: string; resolved: Record<string, unknown> }>(
        '/v1/operator/workers/join-script',
        { method: 'POST', body: JSON.stringify(input) },
      ),
  });
}

// ---- Machines (machine layer) ----

export interface MachineMcpServerInfo {
  server: string;
  toolCount: number;
  healthy: boolean;
}
export interface Machine {
  machineId: string;
  state: 'active' | 'withdrawn' | 'expired';
  callbackUrl: string;
  platform?: string;
  labels?: Record<string, string>;
  mcpServers: string[];
  mcpToolCount: number;
  mcpServerDetails: MachineMcpServerInfo[];
  registeredAt: number;
  heartbeatAt: number;
  heartbeatExpiresAt: number;
}
export function useMachines() {
  return useQuery({
    queryKey: ['machines'],
    queryFn: () => api<{ machines: Machine[] }>('/v1/operator/machines').then((r) => r.machines),
    refetchInterval: 5000,
  });
}

export function useMachineJoinScript() {
  return useMutation({
    mutationFn: (input: { machineId?: string; port?: number } = {}) =>
      api<{ script: string; resolved: Record<string, unknown> }>(
        '/v1/operator/machines/join-script',
        { method: 'POST', body: JSON.stringify(input) },
      ),
  });
}

// ---- Hand recipes (the Hand market) ----

export type HandToolGroup = 'workspace' | 'web';
export interface HandRecipe {
  id: string;
  name: string;
  description?: string;
  /** The machine (environment) this Hand uses. */
  machineId: string;
  /** Free-assembly convenience grouping for the market view (e.g. 系统预装). */
  group?: string;
  /** Common tool families granted besides the machine's always-on exec. */
  toolGroups: HandToolGroup[];
  /** Subset of the machine's exposed MCP server names this Hand references. */
  mcpServerRefs: string[];
}
export function useHandRecipes() {
  return useQuery({
    queryKey: ['hand-recipes'],
    queryFn: () => api<{ recipes: HandRecipe[] }>('/v1/operator/hand-recipes').then((r) => r.recipes),
    refetchInterval: 15_000,
  });
}
export function useRegisterHandRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipe: HandRecipe) =>
      api<HandRecipe>('/v1/operator/hand-recipes', { method: 'POST', body: JSON.stringify(recipe) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hand-recipes'] }); },
  });
}
export function useDeleteHandRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipeId: string) =>
      api(`/v1/operator/hand-recipes/${encodeURIComponent(recipeId)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hand-recipes'] }); },
  });
}

// ---- Machine MCP config (the single source of truth for MCP) ----

export type McpServerConfig = Record<string, unknown>;
export interface MachineMcpConfig {
  machineId: string;
  configPath: string | null;
  mcpServers: Record<string, McpServerConfig>;
}
export function useMachineMcpConfig(machineId: string | null) {
  return useQuery({
    queryKey: ['machine-mcp', machineId],
    queryFn: () => api<MachineMcpConfig>(`/v1/operator/machines/${encodeURIComponent(machineId!)}/mcp-config`),
    enabled: !!machineId,
  });
}
export interface SetMachineMcpResult {
  machineId: string;
  configPath: string;
  mcpServers: string[];
  mcpManifest: { tools: Array<{ server: string; name: string }> };
}
export function useSetMachineMcp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { machineId: string; mcpServers: Record<string, McpServerConfig>; installCommands?: string[] }) =>
      api<SetMachineMcpResult>(
        `/v1/operator/machines/${encodeURIComponent(input.machineId)}/mcp-config`,
        { method: 'POST', body: JSON.stringify({ mcpServers: input.mcpServers, installCommands: input.installCommands ?? [] }) },
      ),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['machine-mcp', v.machineId] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
    },
  });
}

// ---- Usage / consumption (read-only rollup from workers' observe.db) ----

export interface UsageAgentRow {
  agentId: string;
  owner: string | null;
  workerId: string | null;
  sessionCount: number;
  totalCost: number;
  totalTokens: number;
  avgSessionCost: number;
  topTools: Array<{ name: string; count: number }>;
  modelUsage: Record<string, number>;
  // Real per-model cost/token split this agent accounts for (sorted by cost on
  // the worker). Carried over the wire so the 消耗 page can drill a cluster
  // model row back down into the agents that actually spent on it — no new
  // metric, just the same agent data re-sliced.
  modelBreakdown: Array<{ model: string; calls: number; totalCost: number; totalTokens: number }>;
}
export interface UsageProductRow {
  product: string;
  agentCount: number;
  sessionCount: number;
  totalCost: number;
  totalTokens: number;
}
export interface UsageModelRow {
  model: string;
  agentCount: number;
  calls: number;
  totalCost: number;
  totalTokens: number;
}
// Cluster cost trend point — one UTC day. The time rung of the consumption
// layering, fanned in from every agent's per-day spend (向上聚合,不重复记录).
export interface UsageTrendPoint {
  date: string;
  calls: number;
  totalCost: number;
}
export interface OperatorUsage {
  totals: { agentCount: number; sessionCount: number; totalCost: number; totalTokens: number };
  byProduct: UsageProductRow[];
  byModel: UsageModelRow[];
  trend: UsageTrendPoint[];
  agents: UsageAgentRow[];
}
export function useUsage() {
  return useQuery({
    queryKey: ['usage'],
    queryFn: () => api<OperatorUsage>('/v1/operator/usage'),
    refetchInterval: 10_000,
  });
}

// ---- Consumption drill-down: session → turn → inference → detail ----
// Each level is proxied to the agent's owning worker, which reads its
// observe.db. The atoms (one inference) live at the bottom; everything above
// is the worker's own GROUP BY. These power the 「消耗」page's drill-down.

export interface UsageSession {
  id: string;
  agentId: string | null;
  startTime: number;
  endTime: number | null;
  totalCost: number;
  status: string;
  llmCallCount: number;
  toolCallCount: number;
  guardDecisionCount: number;
  compactionCount: number;
  eventCount: number;
}
export interface UsageTurn {
  id: string;
  sessionId: string;
  agentId: string | null;
  prompt: string | null;
  startTime: number;
  endTime: number | null;
  llmCallCount: number;
  toolCallCount: number;
  totalCost: number;
  status: string;
  recoveredFromCrash: boolean;
  orphanedToolCount: number;
  previousTurnId: string | null;
}
export interface UsageInference {
  id: string;
  sessionId: string;
  agentId: string | null;
  turnId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  latencyMs: number;
  ttftMs: number | null;
  stopReason: string;
  messageCount: number;
  toolDefCount: number;
  systemBlockCount: number;
  hasImages: boolean;
  timestamp: number;
}
export interface UsageInferenceToolCall {
  name: string;
  input: string | null;
  output: string | null;
  isError: boolean;
  durationMs: number;
}
export interface UsageInferenceDetail extends UsageInference {
  requestSystem: string | null;
  requestMessages: string | null;
  requestTools: string | null;
  responseContent: string | null;
  providerRequest: string | null;
  providerResponse: string | null;
  providerDetail: string | null;
  toolCalls: UsageInferenceToolCall[];
  guardDecisions: Array<Record<string, unknown>>;
}

export function useUsageSessions(agentId: string | null) {
  return useQuery({
    queryKey: ['usage-sessions', agentId],
    queryFn: () => api<{ sessions: UsageSession[] }>(`/v1/agents/${encodeURIComponent(agentId!)}/usage/sessions`).then((r) => r.sessions),
    enabled: !!agentId,
  });
}
export function useUsageTurns(agentId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['usage-turns', agentId, sessionId],
    queryFn: () => api<{ turns: UsageTurn[] }>(`/v1/agents/${encodeURIComponent(agentId!)}/usage/sessions/${encodeURIComponent(sessionId!)}/turns`).then((r) => r.turns),
    enabled: !!agentId && !!sessionId,
  });
}
export function useUsageInferences(agentId: string | null, turnId: string | null) {
  return useQuery({
    queryKey: ['usage-inferences', agentId, turnId],
    queryFn: () => api<{ inferences: UsageInference[] }>(`/v1/agents/${encodeURIComponent(agentId!)}/usage/turns/${encodeURIComponent(turnId!)}/inferences`).then((r) => r.inferences),
    enabled: !!agentId && !!turnId,
  });
}
export function useUsageInferenceDetail(agentId: string | null, inferenceId: string | null) {
  return useQuery({
    queryKey: ['usage-inference-detail', agentId, inferenceId],
    queryFn: () => api<{ present: boolean; inference: UsageInferenceDetail | null }>(`/v1/agents/${encodeURIComponent(agentId!)}/usage/inferences/${encodeURIComponent(inferenceId!)}`).then((r) => r.inference),
    enabled: !!agentId && !!inferenceId,
  });
}

// ---- Skill registry (the skill market) ----

export interface RegistrySkill {
  name: string;
  description: string;
  builtin: boolean;
  extraFileCount: number;
}
export function useSkills() {
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => api<{ skills: RegistrySkill[] }>('/v1/operator/skills').then((r) => r.skills),
    refetchInterval: 15_000,
  });
}
export interface SkillDetail {
  name: string;
  description: string;
  builtin: boolean;
  content: string;
  files: Array<{ path: string; content: string }>;
}
export function useSkillDetail(name: string | null) {
  return useQuery({
    queryKey: ['skill-detail', name],
    queryFn: () => api<SkillDetail>(`/v1/operator/skills/${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}
export function useRegisterSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description: string; content: string }) =>
      api<RegistrySkill>('/v1/operator/skills', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['skills'] }); },
  });
}
export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api(`/v1/operator/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['skills'] }); },
  });
}
export function useInstallSkillOnAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; name: string }) =>
      api<{ ok: true; agentId: string; name: string }>(
        `/v1/operator/agents/${encodeURIComponent(input.agentId)}/skills/${encodeURIComponent(input.name)}`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: (_d, v) => { void qc.invalidateQueries({ queryKey: ['agent-skills', v.agentId] }); },
  });
}

/** An agent's installed skill names (its home is the source of truth). */
export function useAgentSkills(agentId: string | null) {
  return useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () =>
      api<{ names: string[] }>(`/v1/agents/${encodeURIComponent(agentId!)}/skills`).then((r) => r.names),
    enabled: !!agentId,
  });
}
export function useRemoveAgentSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; name: string }) =>
      api(`/v1/agents/${encodeURIComponent(input.agentId)}/skills/${encodeURIComponent(input.name)}`, { method: 'DELETE' }),
    onSuccess: (_d, v) => { void qc.invalidateQueries({ queryKey: ['agent-skills', v.agentId] }); },
  });
}

// ---- Agents ----

export interface Agent {
  agentId: string;
  workerId: string | null;
}
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/v1/agents').then((r) => r.agents),
    refetchInterval: 5000,
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}

export interface CreateAgentInput {
  agentId: string;
  model: string;
  /** Auto-approval safety classifier model (optional; SDK default when omitted). */
  classifierModel?: string;
  workspace?: string;
  preferredMachine?: string;
  labels?: Record<string, string>;
}
export interface CreateAgentResponse {
  agentId: string;
  workerId: string;
  leaseId: string;
}
export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api<CreateAgentResponse>('/v1/agents', {
        method: 'POST',
        body: JSON.stringify({
          spec: {
            agentId: input.agentId,
            workspace: input.workspace ?? input.agentId,
            model: input.model,
            ...(input.classifierModel ? { classifierModel: input.classifierModel } : {}),
            ensureDefaultMcpConfig: false,
            labels: input.labels,
          },
          preferredMachine: input.preferredMachine,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['cluster'] });
      void qc.invalidateQueries({ queryKey: ['workers'] });
    },
  });
}

// ---- Sessions ----

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt: number;
  lastActiveAt: number;
  status: 'idle' | 'running' | 'interrupted';
  messageCount?: number;
}
export function useSessions(agentId: string | null) {
  return useQuery({
    queryKey: ['sessions', agentId],
    queryFn: () =>
      api<{ sessions: SessionSummary[] }>(`/v1/agents/${encodeURIComponent(agentId!)}/sessions`)
        .then((r) => r.sessions),
    enabled: !!agentId,
  });
}

// ---- Leases ----

export interface Lease {
  leaseId: string;
  agentId: string;
  holderId: string;
  workerId?: string;
  state: 'active' | 'released' | 'expired';
  acquiredAt: number;
  renewedAt?: number;
  expiresAt: number;
  releasedAt?: number;
}
export function useLeases() {
  return useQuery({
    queryKey: ['leases'],
    queryFn: () => api<{ leases: Lease[] }>('/v1/operator/leases').then((r) => r.leases),
    refetchInterval: 10_000,
  });
}

// ---- Wakes ----

export interface Wake {
  wakeId: string;
  agentId: string;
  reason: string;
  state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  dueAt: number;
  errorMessage?: string;
}
export function useWakes() {
  return useQuery({
    queryKey: ['wakes'],
    queryFn: () => api<{ wakes: Wake[] }>('/v1/operator/wakes').then((r) => r.wakes),
    refetchInterval: 5000,
  });
}
export function useCancelWake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (wakeId: string) =>
      api(`/v1/operator/wakes/${encodeURIComponent(wakeId)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wakes'] }); },
  });
}
export function useScheduleWake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; dueAt: number; reason: string; sessionId?: string }) =>
      api<{ wakeId: string; dueAt: number }>('/v1/wakes/schedule', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wakes'] }); },
  });
}

// ---- Product credentials (scoped bp_… tokens) ----

export interface ProductCredentialInfo {
  product: string;
  createdAt: number;
  label?: string;
}
export function useCredentials() {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: () => api<{ credentials: ProductCredentialInfo[] }>('/v1/operator/credentials').then((r) => r.credentials),
    refetchInterval: 15_000,
  });
}
export interface IssuedCredential {
  product: string;
  token: string;
  createdAt: number;
  label?: string;
}
export function useIssueCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { product: string; label?: string }) =>
      api<IssuedCredential>('/v1/operator/credentials', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['credentials'] }); },
  });
}
export function useRevokeCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (product: string) =>
      api(`/v1/operator/credentials/${encodeURIComponent(product)}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['credentials'] }); },
  });
}

// ---- Audit log ----

export interface AuditEntry {
  ts: number;
  action: string;
  actor: string;
  sourceIp?: string;
  target?: string;
  outcome: 'ok' | 'err';
  details?: Record<string, unknown>;
}
export interface AuditQuery {
  from?: number;
  to?: number;
  action?: string;
  outcome?: 'ok' | 'err';
  limit?: number;
}
export function useAudit(q: AuditQuery) {
  const params = new URLSearchParams();
  if (q.from != null) params.set('from', String(q.from));
  if (q.to != null) params.set('to', String(q.to));
  if (q.action) params.set('action', q.action);
  if (q.outcome) params.set('outcome', q.outcome);
  if (q.limit != null) params.set('limit', String(q.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['audit', qs],
    queryFn: () => api<{ entries: AuditEntry[]; truncated: boolean }>(`/v1/operator/audit${qs ? `?${qs}` : ''}`),
    refetchInterval: 10_000,
  });
}

// ---- Models template ----

/** Per-protocol base URLs for a provider channel. */
export interface ProviderEndpoints {
  anthropic?: string;
  openai?: string;
}

export type WireProtocol = 'anthropic' | 'openai';

export interface ModelsTemplate {
  providers: Record<string, {
    presetId: string;
    apiKey: string;
    endpoints?: ProviderEndpoints;
    label?: string;
    knownModels?: string[];
    [k: string]: unknown;
  }>;
  models: Record<string, {
    label?: string;
    contextWindow?: number;
    providers: Array<{ providerId: string; remoteModelId?: string }>;
    /** Inferred protocol family, attached by a8s on GET (UI never recomputes). */
    family?: WireProtocol;
    [k: string]: unknown;
  }>;
  tiers: Record<string, string>;
}
export interface ModelsTemplateResponse {
  template: ModelsTemplate | null;
  updatedAt: number | null;
}
export function useModelsTemplate() {
  return useQuery({
    queryKey: ['models-template'],
    queryFn: () => api<ModelsTemplateResponse>('/v1/operator/models-template'),
  });
}
export function usePutModelsTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (template: ModelsTemplate) =>
      api('/v1/operator/models-template', {
        method: 'PUT',
        body: JSON.stringify({ template }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['models-template'] }); },
  });
}

/**
 * Flattened, pickable model entries for the generic EntityPicker: every tier
 * (`tier:strong`) plus every configured model, each tagged with its protocol
 * family so the picker can badge it (and later disable cross-family choices).
 * This is the single list any "pick a model" surface (agent create, classifier,
 * admin) reuses — no page re-derives it.
 */
export interface ModelEntry {
  /** The value an agent requests: `tier:strong` or a model id. */
  id: string;
  /** Display label (model label or the id). */
  label: string;
  /** anthropic / openai — drives the family badge and family-lock. */
  family?: WireProtocol;
  /** True for tier aliases (L3), false for concrete models (L2). */
  isTier: boolean;
  /** For tiers: the model id it points at. */
  target?: string;
}
export function useModelEntries() {
  const template = useModelsTemplate();
  const entries: ModelEntry[] = (() => {
    const t = template.data?.template;
    if (!t) return [];
    const models: ModelEntry[] = Object.entries(t.models).map(([id, m]) => ({
      id,
      label: m.label ?? id,
      family: m.family,
      isTier: false,
    }));
    const familyOf = new Map(models.map((m) => [m.id, m.family]));
    const tiers: ModelEntry[] = Object.entries(t.tiers ?? {}).map(([slot, target]) => ({
      id: `tier:${slot}`,
      label: `tier:${slot}`,
      family: familyOf.get(target),
      isTier: true,
      target,
    }));
    return [...tiers, ...models];
  })();
  return { ...template, data: entries };
}

// ---- Models: presets + live probe (human-friendly provider setup) ----

export interface ModelsPreset {
  id: string;
  label: string;
  endpoints: ProviderEndpoints;
  protocols: WireProtocol[];
  canList: boolean;
  apiKeyDocsUrl?: string;
}
export function useModelsPresets() {
  return useQuery({
    queryKey: ['models-presets'],
    queryFn: () => api<{ presets: ModelsPreset[] }>('/v1/operator/models/presets').then((r) => r.presets),
    staleTime: Infinity, // built-in, never changes within a session
  });
}

export interface ModelsProbeInput {
  presetId?: string;
  protocol?: WireProtocol;
  baseUrl?: string;
  apiKey: string;
}
export interface ModelsProbeResult {
  models: string[];
  source: 'live' | 'known';
  warning?: string;
}
export function useProbeModels() {
  return useMutation({
    mutationFn: (input: ModelsProbeInput) =>
      api<ModelsProbeResult>('/v1/operator/models/probe', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

// ---- Admin agent (berry-admin) ----

export interface AdminAgentStatus {
  agentId: string;
  present: boolean;
  workerId: string | null;
}
export function useAdminAgentStatus() {
  return useQuery({
    queryKey: ['admin-agent'],
    queryFn: () => api<AdminAgentStatus>('/v1/operator/admin-agent'),
    refetchInterval: 10_000,
  });
}
export function useEnsureAdminAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AdminAgentStatus>('/v1/operator/admin-agent', { method: 'POST', body: '{}' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-agent'] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

// ---- Health ----

export interface Health {
  ok: boolean;
  version: string;
  uptime: number;
}
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => fetch('/v1/health').then((r) => r.json() as Promise<Health>),
    refetchInterval: 10_000,
  });
}

// ---- Admin chat ----

export interface SendResponse {
  sessionId: string;
  result: {
    sessionId: string;
    assistantMessage?: { content?: string };
    result?: { text?: string };
  };
}
export function useAdminChat() {
  return useMutation({
    // sessionId continues an existing session; omit to start a new one.
    mutationFn: (input: { prompt: string; sessionId?: string }) =>
      api<SendResponse>('/v1/agents/berry-admin/send', {
        method: 'POST',
        body: JSON.stringify({ prompt: input.prompt, sessionId: input.sessionId }),
      }),
  });
}

/**
 * Load a session's persisted events (the durable timeline) so the chat UI
 * can rebuild history when an operator selects a past session. The SDK
 * session is the source of truth — Claw/the UI hold no message state.
 */
export interface RawSessionEvent {
  id: string;
  type: string;
  [k: string]: unknown;
}
export function useSessionEvents(agentId: string, sessionId: string | null) {
  return useQuery({
    queryKey: ['session-events', agentId, sessionId],
    queryFn: () =>
      api<{ events: RawSessionEvent[]; nextBefore: string | null; reachedStart: boolean }>(
        `/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId!)}/events?limit=1000`,
      ).then((r) => r.events),
    enabled: !!sessionId,
  });
}
