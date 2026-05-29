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
