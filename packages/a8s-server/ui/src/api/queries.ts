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

export interface Machine {
  machineId: string;
  state: 'active' | 'withdrawn' | 'expired';
  callbackUrl: string;
  platform?: string;
  labels?: Record<string, string>;
  mcpServers: string[];
  mcpToolCount: number;
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

export interface HandRecipe {
  id: string;
  name: string;
  description?: string;
  /** 'machine' = a machine-bound Hand. ('mcp' may appear from legacy data.) */
  kind: 'machine' | 'mcp';
  /** The machine this Hand is bound to (machine-inborn). */
  machineId?: string;
  /** Free-assembly convenience grouping for the market view (e.g. 系统预装). */
  group?: string;
  mcpServers: Record<string, Record<string, unknown>>;
  installCommands: string[];
  envVarNames: string[];
  builtin: boolean;
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
    mutationFn: (recipe: Omit<HandRecipe, 'builtin'>) =>
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
export interface LandRecipeResult {
  machineId: string;
  recipeId: string;
  configPath: string;
  mcpServers: string[];
  mcpManifest: { tools: Array<{ server: string; name: string }> };
}
export function useLandHandRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { machineId: string; recipeId: string; configPath?: string }) =>
      api<LandRecipeResult>(
        `/v1/operator/machines/${encodeURIComponent(input.machineId)}/hand-recipes/${encodeURIComponent(input.recipeId)}`,
        { method: 'POST', body: JSON.stringify(input.configPath ? { configPath: input.configPath } : {}) },
      ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['machines'] }); },
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

// ---- Models template ----

export interface ModelsTemplate {
  providers: Record<string, {
    presetId: string;
    apiKey: string;
    baseUrl?: string;
    label?: string;
    [k: string]: unknown;
  }>;
  models: Record<string, {
    label?: string;
    contextWindow?: number;
    providers: Array<{ providerId: string; remoteModelId?: string }>;
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

// ---- Models: presets + live probe (human-friendly provider setup) ----

export interface ModelsPreset {
  id: string;
  label: string;
  type: 'anthropic' | 'openai';
  baseUrl: string;
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
  baseUrl?: string;
  apiKey: string;
  type?: 'anthropic' | 'openai';
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
