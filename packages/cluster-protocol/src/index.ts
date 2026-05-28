// ============================================================
// @berry-agent/cluster-protocol — HTTP wire protocol
// ============================================================
// Single fact source for the JSON shapes that flow between
// products → a8s-server → worker-daemon. Every request/response is
// declared as a zod schema; the corresponding TypeScript types come from
// z.infer so a8s-server and worker-daemon cannot drift.
//
// Path conventions:
//   /v1/workers/...    — worker registration & control (worker → a8s)
//   /v1/agents/...     — agent lifecycle (product → a8s, a8s → worker)
//   /v1/wakes/...      — wake schedule API (worker → a8s, optional clients)
//   /v1/health         — liveness
//
// Wire body convention: always `application/json`, top-level object.
// Errors: HTTP status + `{ error: { code, message } }`.

import { z } from 'zod';

// ============================================================
// Common shapes
// ============================================================

export const errorPayloadSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
}).strict();
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

// ============================================================
// Worker registration & control
// ============================================================

/** Worker daemon → a8s: "I'm here, here's what I can do." */
export const workerRegistrationRequestSchema = z.object({
  /** Stable id chosen by the worker; persists across restarts. */
  workerId: z.string().min(1),
  /** Worker's external URL so a8s can call back (e.g. http://10.0.1.5:7100). */
  callbackUrl: z.string().url(),
  /** Max concurrent agents this worker will accept. */
  capacity: z.number().int().nonnegative(),
  /** Heartbeat TTL the worker will respect; a8s should evict if not refreshed. */
  heartbeatTtlMs: z.number().int().positive(),
  /** Optional opaque labels for affinity scheduling (e.g. {"region":"us-west"}). */
  labels: z.record(z.string()).optional(),
}).strict();
export type WorkerRegistrationRequest = z.infer<typeof workerRegistrationRequestSchema>;

export const workerRegistrationResponseSchema = z.object({
  workerId: z.string().min(1),
  /** Echo of the registered TTL so the worker knows how often to ping. */
  heartbeatTtlMs: z.number().int().positive(),
  /** Token the worker uses on subsequent calls to authenticate. */
  workerToken: z.string().min(1),
}).strict();
export type WorkerRegistrationResponse = z.infer<typeof workerRegistrationResponseSchema>;

export const workerHeartbeatRequestSchema = z.object({
  /** Optional capacity update; omit to keep current. */
  capacity: z.number().int().nonnegative().optional(),
}).strict();
export type WorkerHeartbeatRequest = z.infer<typeof workerHeartbeatRequestSchema>;

export const workerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  /** Updated TTL the worker should respect. */
  heartbeatTtlMs: z.number().int().positive(),
}).strict();
export type WorkerHeartbeatResponse = z.infer<typeof workerHeartbeatResponseSchema>;

export const workerWithdrawRequestSchema = z.object({
  /** Optional drain mode: stop accepting new agents but keep running existing ones. */
  drain: z.boolean().optional(),
}).strict();
export type WorkerWithdrawRequest = z.infer<typeof workerWithdrawRequestSchema>;

// ============================================================
// Agent lifecycle — product → a8s
// ============================================================

/**
 * Product → a8s: "create this agent."
 * `spec` is a *wire* spec — serializable subset of WorkerAgentSpec. It
 * intentionally does not contain hostTools or executionEnvironmentProvider
 * (those are not transportable); worker daemons resolve them locally from
 * the agent's persistent config.
 */
export const wireAgentSpecSchema = z.object({
  agentId: z.string().min(1),
  workspace: z.string().min(1),
  projectRoot: z.string().optional(),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
  toolDenylist: z.array(z.string()).optional(),
  ensureDefaultMcpConfig: z.boolean().optional(),
  /** Free-form labels for the agent. Used by scheduler / observability. */
  labels: z.record(z.string()).optional(),
}).strict();
export type WireAgentSpec = z.infer<typeof wireAgentSpecSchema>;

export const createAgentRequestSchema = z.object({
  spec: wireAgentSpecSchema,
  /**
   * Opaque product metadata stored alongside the assignment. Used by
   * product callbacks and surfaced via getAgentLocation.
   */
  entry: z.record(z.unknown()).optional(),
  /**
   * Affinity hint: which worker would the caller prefer? a8s scheduler
   * may ignore. Useful for "stay on the same worker after redeploy."
   */
  preferredWorkerId: z.string().optional(),
}).strict();
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const createAgentResponseSchema = z.object({
  agentId: z.string().min(1),
  workerId: z.string().min(1),
  /** Lease id; clients can use this to assert ownership later. */
  leaseId: z.string().min(1),
}).strict();
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;

export const agentLocationSchema = z.object({
  agentId: z.string().min(1),
  workerId: z.string().nullable(),
}).strict();
export type AgentLocation = z.infer<typeof agentLocationSchema>;

export const listAgentsResponseSchema = z.object({
  agents: z.array(agentLocationSchema),
}).strict();
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;

// ============================================================
// Agent data plane — product → a8s → worker (proxied)
// ============================================================
//
// a8s receives data-plane requests on a stable URL, looks up which worker
// owns the agent, and forwards to that worker. The worker actually runs
// the AgentSession method. Products only ever talk to a8s.

/** Send a turn to an agent. */
export const sendRequestSchema = z.object({
  /** Plain text or pre-formed ContentBlock[]. We accept opaque JSON here —
   *  the SDK validates the actual content block shape. */
  prompt: z.union([z.string(), z.array(z.record(z.unknown()))]),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
}).strict();
export type SendRequest = z.infer<typeof sendRequestSchema>;

/** The full ManagedAgentTurnResult is opaque to the protocol — products
 *  parse it through the SDK's own zod schema. */
export const sendResponseSchema = z.object({
  sessionId: z.string().min(1),
  /** Opaque turn result; SDK shape. */
  result: z.record(z.unknown()),
}).strict();
export type SendResponse = z.infer<typeof sendResponseSchema>;

export const getActiveSessionResponseSchema = z.object({
  sessionId: z.string().nullable(),
}).strict();
export type GetActiveSessionResponse = z.infer<typeof getActiveSessionResponseSchema>;

// ============================================================
// Worker-side endpoints (a8s → worker)
// ============================================================
// These are the methods a8s calls on a worker daemon. Roughly mirror
// WorkerNode but as HTTP wire shapes.

/** a8s → worker: capacity probe. */
export const workerCapacityResponseSchema = z.object({
  used: z.number().int().nonnegative(),
  /** Total capacity. Send Infinity as a sentinel by omitting the field. */
  total: z.number().int().nonnegative().optional(),
}).strict();
export type WorkerCapacityResponse = z.infer<typeof workerCapacityResponseSchema>;

/** a8s → worker: start an agent locally. */
export const workerRunAgentRequestSchema = z.object({
  spec: wireAgentSpecSchema,
  entry: z.record(z.unknown()).optional(),
}).strict();
export type WorkerRunAgentRequest = z.infer<typeof workerRunAgentRequestSchema>;

export const workerRunAgentResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
export type WorkerRunAgentResponse = z.infer<typeof workerRunAgentResponseSchema>;

/** a8s → worker: stop an agent. */
export const workerStopAgentResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
export type WorkerStopAgentResponse = z.infer<typeof workerStopAgentResponseSchema>;

/** a8s → worker: does this agent exist on this worker? */
export const workerHasAgentResponseSchema = z.object({
  has: z.boolean(),
}).strict();
export type WorkerHasAgentResponse = z.infer<typeof workerHasAgentResponseSchema>;

// ============================================================
// Wake control plane
// ============================================================

export const scheduleWakeRequestSchema = z.object({
  agentId: z.string().min(1),
  dueAt: z.number().int(),
  reason: z.string().min(1),
  sessionId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
}).strict();
export type ScheduleWakeRequest = z.infer<typeof scheduleWakeRequestSchema>;

export const scheduleWakeResponseSchema = z.object({
  wakeId: z.string().min(1),
  dueAt: z.number().int(),
}).strict();
export type ScheduleWakeResponse = z.infer<typeof scheduleWakeResponseSchema>;

// ============================================================
// Health
// ============================================================

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptime: z.number().int().nonnegative(),
}).strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ============================================================
// Path constants
// ============================================================

export const CLUSTER_PROTOCOL_VERSION = 'v1' as const;

export const A8S_PATHS = {
  health: `/${CLUSTER_PROTOCOL_VERSION}/health`,
  workersRegister: `/${CLUSTER_PROTOCOL_VERSION}/workers/register`,
  workerHeartbeat: (workerId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/workers/${encodeURIComponent(workerId)}/heartbeat`,
  workerWithdraw: (workerId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/workers/${encodeURIComponent(workerId)}/withdraw`,
  agents: `/${CLUSTER_PROTOCOL_VERSION}/agents`,
  agent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}`,
  agentSend: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/send`,
  agentActiveSession: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/active-session`,
  wakesSchedule: `/${CLUSTER_PROTOCOL_VERSION}/wakes/schedule`,
} as const;

export const WORKER_PATHS = {
  health: `/${CLUSTER_PROTOCOL_VERSION}/health`,
  capacity: `/${CLUSTER_PROTOCOL_VERSION}/capacity`,
  runAgent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/run`,
  stopAgent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/stop`,
  agentSend: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/send`,
  agentActiveSession: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/active-session`,
  hasAgent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/has`,
} as const;

// ============================================================
// Auth helpers — minimal Bearer-token scheme
// ============================================================

export const WORKER_AUTH_HEADER = 'Authorization' as const;
export const WORKER_AUTH_SCHEME = 'Bearer' as const;

export function workerAuthHeader(token: string): string {
  return `${WORKER_AUTH_SCHEME} ${token}`;
}

export function parseWorkerAuthHeader(value: string | undefined): string | null {
  if (!value) return null;
  const prefix = `${WORKER_AUTH_SCHEME} `;
  if (!value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}
