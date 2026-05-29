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
    mutationFn: (prompt: string) =>
      api<SendResponse>('/v1/agents/berry-admin/send', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      }),
  });
}
