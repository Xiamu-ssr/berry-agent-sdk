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
  /**
   * Agents this worker has already mounted in memory at registration
   * time (typically empty on fresh start; non-empty when an a8s control
   * plane restart left the worker holding live mounts the new control
   * plane has no record of). a8s reconciles: any agent in this list
   * whose lease is missing or held by someone else is rebound to the
   * registering worker — the worker process is authoritative because
   * its in-memory mount IS the runtime. This closes the loop with
   * `ownedAgents` in the response: ownedAgents = "what a8s thinks you
   * should own", mountedAgents = "what you actually own". After
   * register, both sides converge.
   */
  mountedAgents: z.array(z.string().min(1)).optional().default([]),
}).strict();
export type WorkerRegistrationRequest = z.infer<typeof workerRegistrationRequestSchema>;

export const workerRegistrationResponseSchema = z.object({
  workerId: z.string().min(1),
  /** Echo of the registered TTL so the worker knows how often to ping. */
  heartbeatTtlMs: z.number().int().positive(),
  /** Token the worker uses on subsequent calls to authenticate. */
  workerToken: z.string().min(1),
  /**
   * Agents that durable lease state says this worker already owns. The
   * worker daemon mounts these from disk after registration. Typically
   * non-empty only when a worker restarts after a crash — fresh joins
   * see an empty array.
   */
  ownedAgents: z.array(z.string().min(1)).default([]),
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
// Machine registration & control  (the "machine layer")
// ============================================================
//
// A *machine* is a host that offers an ExecutionEnvironment to the
// cluster without running agent brains. It registers like a worker
// (admin token bootstrap → machine token), heartbeats, and serves an
// /exec endpoint a8s can call back. a8s projects each registered
// machine into a remote ExecutionEnvironment whose createHands() yields
// machine-bound exec/file Hands; agents opt in by label.
//
// Why separate from workers: a worker mounts agent runtimes (heavy,
// holds leases, capacity-scheduled). A machine only lends an execution
// surface (light, no brain, no lease). Conflating them would force a
// machine to carry capacity/lease semantics it has no use for.

/** Machine connector → a8s: "I'm a host you can run commands on." */
export const machineRegistrationRequestSchema = z.object({
  /** Stable id chosen by the connector; persists across restarts. */
  machineId: z.string().min(1),
  /** Connector's external URL so a8s can call back for /exec. */
  callbackUrl: z.string().url(),
  /** Heartbeat TTL the connector will respect. */
  heartbeatTtlMs: z.number().int().positive(),
  /** OS family so the scheduler / UI can show it and skills can adapt. */
  platform: z.enum(['macos', 'linux', 'windows', 'other']).optional(),
  /** Opaque labels (e.g. {"env":"office","arch":"arm64"}). */
  labels: z.record(z.string()).optional(),
  /**
   * MCP server ids the connector found in the machine's local .mcp.json
   * and can proxy. a8s lists these as available Hands; the actual proxy
   * wiring is M6. Empty / omitted on a connector with no local MCP.
   */
  mcpServers: z.array(z.string().min(1)).optional().default([]),
}).strict();
export type MachineRegistrationRequest = z.infer<typeof machineRegistrationRequestSchema>;

export const machineRegistrationResponseSchema = z.object({
  machineId: z.string().min(1),
  heartbeatTtlMs: z.number().int().positive(),
  /** Token the connector uses on subsequent calls; a8s uses it to call back. */
  machineToken: z.string().min(1),
}).strict();
export type MachineRegistrationResponse = z.infer<typeof machineRegistrationResponseSchema>;

export const machineHeartbeatRequestSchema = z.object({}).strict();
export type MachineHeartbeatRequest = z.infer<typeof machineHeartbeatRequestSchema>;

export const machineHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  heartbeatTtlMs: z.number().int().positive(),
}).strict();
export type MachineHeartbeatResponse = z.infer<typeof machineHeartbeatResponseSchema>;

export const machineWithdrawRequestSchema = z.object({}).strict();
export type MachineWithdrawRequest = z.infer<typeof machineWithdrawRequestSchema>;

/**
 * a8s → machine connector: "run this command on your host."
 * Mirrors the SDK's RemoteExecRequest (tools-common) but is the
 * cross-process source of truth so the connector needn't depend on
 * tools-common. The connector executes via a local NodeExecutor.
 */
export const machineExecRequestSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
  maxBuffer: z.number().int().positive().optional(),
}).strict();
export type MachineExecRequest = z.infer<typeof machineExecRequestSchema>;

export const machineExecReplySchema = z.object({
  output: z.string(),
  isError: z.boolean(),
}).strict();
export type MachineExecReply = z.infer<typeof machineExecReplySchema>;

/** Operator view of one registered machine. */
export const operatorMachineSchema = z.object({
  machineId: z.string().min(1),
  state: z.enum(['active', 'withdrawn', 'expired']),
  callbackUrl: z.string(),
  platform: z.string().optional(),
  labels: z.record(z.string()).optional(),
  mcpServers: z.array(z.string()).default([]),
  registeredAt: z.number().int(),
  heartbeatAt: z.number().int(),
  heartbeatExpiresAt: z.number().int(),
}).strict();
export type OperatorMachine = z.infer<typeof operatorMachineSchema>;

export const operatorMachineListResponseSchema = z.object({
  machines: z.array(operatorMachineSchema),
}).strict();
export type OperatorMachineListResponse = z.infer<typeof operatorMachineListResponseSchema>;

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
  /**
   * Affinity hint: which machine should the agent land on? a8s scheduler
   * prefers a worker whose `labels.machine` matches, falling back to its
   * default policy otherwise. Used to keep agents on the host where
   * their on-disk home already lives (same-machine failover affinity).
   */
  preferredMachine: z.string().optional(),
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
// Session list & event pagination
// ============================================================
// Products call a8s; a8s proxies to the worker holding the agent. The
// session-summary payload is intentionally minimal — full SessionView
// hydration (with messages) is opt-in via includeMessages so list calls
// stay cheap when the UI is rendering a sidebar.

export const sessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  status: z.enum(['idle', 'running', 'interrupted']),
  /** Number of messages in the rendered timeline (omitted when not hydrated). */
  messageCount: z.number().int().nonnegative().optional(),
}).strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
}).strict();
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/**
 * Event-log pagination request. Cursor is the *exclusive* upper bound
 * (event id) — the response returns events that come **before** it in
 * the append order. `null`/omitted cursor = newest page. Limit clamps
 * server-side (default 200, max 1000) so a misbehaving UI can't tail
 * the entire history in one round trip.
 */
export const sessionEventsRequestSchema = z.object({
  before: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
}).strict();
export type SessionEventsRequest = z.infer<typeof sessionEventsRequestSchema>;

export const sessionEventsResponseSchema = z.object({
  /** Raw SessionEvent objects — SDK shape, opaque to the protocol. */
  events: z.array(z.record(z.unknown())),
  /** Cursor for the next older page; null when no more history. */
  nextBefore: z.string().nullable(),
  /** True when this page reaches the start of the log. */
  reachedStart: z.boolean(),
}).strict();
export type SessionEventsResponse = z.infer<typeof sessionEventsResponseSchema>;

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
// Operator API — cluster admin surface
// ============================================================
// Read + control endpoints for cluster operators (humans and the
// berry-admin agent). Path-scoped under /v1/operator; admin-token gated.
// Wire types are intentionally serialisable mirrors of the SDK's
// RuntimeWorker / RuntimeLease so the operator never needs the SDK type
// just to render a table.

export const operatorWorkerSchema = z.object({
  workerId: z.string().min(1),
  state: z.enum(['active', 'draining', 'evicted', 'withdrawn']),
  capacity: z.number().int().nonnegative(),
  /** How many agents are currently mounted there (a8s in-memory). */
  used: z.number().int().nonnegative(),
  callbackUrl: z.string().url(),
  labels: z.record(z.string()).optional(),
  registeredAt: z.number().int(),
  heartbeatAt: z.number().int(),
  heartbeatExpiresAt: z.number().int(),
  drainedAt: z.number().int().optional(),
  evictedAt: z.number().int().optional(),
  withdrawnAt: z.number().int().optional(),
}).strict();
export type OperatorWorker = z.infer<typeof operatorWorkerSchema>;

export const operatorWorkerListResponseSchema = z.object({
  workers: z.array(operatorWorkerSchema),
}).strict();
export type OperatorWorkerListResponse = z.infer<typeof operatorWorkerListResponseSchema>;

export const operatorLeaseSchema = z.object({
  leaseId: z.string().min(1),
  agentId: z.string().min(1),
  holderId: z.string().min(1),
  workerId: z.string().optional(),
  state: z.enum(['active', 'released', 'expired']),
  acquiredAt: z.number().int(),
  renewedAt: z.number().int().optional(),
  expiresAt: z.number().int(),
  releasedAt: z.number().int().optional(),
  sessionId: z.string().optional(),
}).strict();
export type OperatorLease = z.infer<typeof operatorLeaseSchema>;

export const operatorLeaseListResponseSchema = z.object({
  leases: z.array(operatorLeaseSchema),
}).strict();
export type OperatorLeaseListResponse = z.infer<typeof operatorLeaseListResponseSchema>;

export const operatorClusterReportSchema = z.object({
  workerCount: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    draining: z.number().int().nonnegative(),
    evicted: z.number().int().nonnegative(),
  }).strict(),
  capacity: z.object({
    total: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
  }).strict(),
  agentCount: z.number().int().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
}).strict();
export type OperatorClusterReport = z.infer<typeof operatorClusterReportSchema>;

export const operatorOkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type OperatorOkResponse = z.infer<typeof operatorOkResponseSchema>;

// ============================================================
// Operator: models template (LLM provider/model/tier config)
// ============================================================
//
// a8s stores a single template describing the providers, models, and
// tier mappings the cluster knows about. Workers fetch this template
// when they register (if their local worker.json.registry is null) so
// operators only have to configure LLMs in one place — the UI — and
// every new worker auto-inherits.
//
// IMPORTANT: this is a *template*. Each worker holds its own copy
// after registration; rotating an API key requires either pushing the
// new template + restarting workers, or letting workers pull on next
// register. The template is intentionally NOT a runtime authority —
// brain calls still leave from the worker, using the worker's local
// copy of the credentials.
//
// Schema is purposefully wide (passthrough) so the UI doesn't need to
// be redeployed every time @berry-agent/models gains a new field.

export const modelsProviderSchema = z.object({
  id: z.string().min(1).optional(),
  presetId: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  type: z.enum(['anthropic', 'openai']).optional(),
  label: z.string().optional(),
  knownModels: z.array(z.string()).optional(),
}).passthrough();

export const modelsModelSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  providers: z.array(z.object({
    providerId: z.string().min(1),
    remoteModelId: z.string().optional(),
  }).passthrough()).min(1),
}).passthrough();

export const modelsTemplateSchema = z.object({
  providers: z.record(z.string(), modelsProviderSchema),
  models: z.record(z.string(), modelsModelSchema),
  tiers: z.record(z.string(), z.string()),
}).strict();
export type ModelsTemplate = z.infer<typeof modelsTemplateSchema>;

export const modelsTemplateGetResponseSchema = z.object({
  /** `null` means no template has been configured yet. */
  template: modelsTemplateSchema.nullable(),
  /** Unix ms when the template was last updated; null when unset. */
  updatedAt: z.number().int().nullable(),
}).strict();
export type ModelsTemplateGetResponse = z.infer<typeof modelsTemplateGetResponseSchema>;

export const modelsTemplatePutRequestSchema = z.object({
  template: modelsTemplateSchema,
}).strict();
export type ModelsTemplatePutRequest = z.infer<typeof modelsTemplatePutRequestSchema>;

// ============================================================
// Operator: admin agent (berry-admin) bootstrap
// ============================================================
//
// GET reports whether the cluster's berry-admin agent is scheduled and
// where. POST schedules it onto an active worker (idempotent). The
// worker that mounts it injects the cluster-admin tools by label.

export const adminAgentStatusResponseSchema = z.object({
  /** Stable agent id, always 'berry-admin' for now. */
  agentId: z.string().min(1),
  /** True once the agent is assigned to a worker. */
  present: z.boolean(),
  /** Worker the agent is mounted on; null when not yet scheduled. */
  workerId: z.string().nullable(),
}).strict();
export type AdminAgentStatusResponse = z.infer<typeof adminAgentStatusResponseSchema>;

// ============================================================
// Operator: wake queue view
// ============================================================
//
// Wakes go through pending → claimed → completed | failed | cancelled.
// Operators want to see the queue to debug long-tail tasks ("why hasn't
// my agent woken up at 9 am yet?") and to cancel obsolete schedules.

export const operatorWakeSchema = z.object({
  wakeId: z.string().min(1),
  agentId: z.string().min(1),
  reason: z.string().min(1),
  state: z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled']),
  createdAt: z.number().int(),
  dueAt: z.number().int(),
  claimedAt: z.number().int().optional(),
  completedAt: z.number().int().optional(),
  failedAt: z.number().int().optional(),
  cancelledAt: z.number().int().optional(),
  errorMessage: z.string().optional(),
  sessionId: z.string().optional(),
}).passthrough();
export type OperatorWake = z.infer<typeof operatorWakeSchema>;

export const operatorWakeListResponseSchema = z.object({
  wakes: z.array(operatorWakeSchema),
}).strict();
export type OperatorWakeListResponse = z.infer<typeof operatorWakeListResponseSchema>;

/**
 * Operator → a8s: "give me a copy-paste-able shell snippet that will
 * install + start a worker on a fresh host so it joins this cluster."
 *
 * Inputs are hints, not requirements. workerId defaults to the target
 * host's hostname; capacity/port have sensible defaults. The reply is
 * plain bash text the operator pastes into an SSH session — no binary
 * download, no scripted curl-pipe-to-sh, no TLS dance.
 */
export const operatorJoinScriptRequestSchema = z.object({
  workerId: z.string().min(1).optional(),
  capacity: z.number().int().positive().optional(),
  port: z.number().int().positive().optional(),
  /** Hostname/IP the worker should advertise back to a8s. Defaults to `$(hostname)`. */
  bindHost: z.string().min(1).optional(),
  /** Data root override; defaults to /var/berry/workers/<workerId>. */
  dataRoot: z.string().min(1).optional(),
  /** Optional labels stamped on the worker entry. */
  labels: z.record(z.string()).optional(),
}).strict();
export type OperatorJoinScriptRequest = z.infer<typeof operatorJoinScriptRequestSchema>;

export const operatorJoinScriptResponseSchema = z.object({
  /** Bash snippet the operator pastes into an SSH session on the new host. */
  script: z.string().min(1),
  /** Echo of the resolved config so the operator can verify before pasting. */
  resolved: z.object({
    workerId: z.string(),
    capacity: z.number().int(),
    port: z.number().int(),
    a8sUrl: z.string(),
    dataRoot: z.string(),
  }).strict(),
}).strict();
export type OperatorJoinScriptResponse = z.infer<typeof operatorJoinScriptResponseSchema>;

// ---- Machine connector join-script ----

export const operatorMachineJoinScriptRequestSchema = z.object({
  machineId: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  /** Hostname/IP the connector advertises back to a8s. Defaults to `$(hostname)`. */
  bindHost: z.string().min(1).optional(),
  labels: z.record(z.string()).optional(),
}).strict();
export type OperatorMachineJoinScriptRequest = z.infer<typeof operatorMachineJoinScriptRequestSchema>;

export const operatorMachineJoinScriptResponseSchema = z.object({
  script: z.string().min(1),
  resolved: z.object({
    machineId: z.string(),
    port: z.number().int(),
    a8sUrl: z.string(),
  }).strict(),
}).strict();
export type OperatorMachineJoinScriptResponse = z.infer<typeof operatorMachineJoinScriptResponseSchema>;

// ============================================================
// Live event stream (Server-Sent Events)
// ============================================================
// Wire shape:
//   GET /v1/agents/:id/events/stream?session=<sid>
//     Accept: text/event-stream
//     [optional] Last-Event-ID: <eventId>   ← resume cursor
//
//   Server emits one SSE message per SessionEvent:
//     id: <event.id>
//     event: <event.type>
//     data: <JSON of the SessionEvent>
//
// `session` query param is optional — when present, the stream is
// filtered to that session id. When omitted, all session events for
// the agent flow through. Last-Event-ID lets clients reconnect after
// drops without losing events; the server replays from after that id.
// Streams stay open indefinitely; clients close to unsubscribe.

export const SSE_LAST_EVENT_ID_HEADER = 'Last-Event-ID' as const;
export const SSE_SESSION_QUERY_PARAM = 'session' as const;

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
  machinesRegister: `/${CLUSTER_PROTOCOL_VERSION}/machines/register`,
  machineHeartbeat: (machineId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/machines/${encodeURIComponent(machineId)}/heartbeat`,
  machineWithdraw: (machineId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/machines/${encodeURIComponent(machineId)}/withdraw`,
  agents: `/${CLUSTER_PROTOCOL_VERSION}/agents`,
  agent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}`,
  agentSend: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/send`,
  agentActiveSession: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/active-session`,
  agentSessions: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions`,
  agentSessionEvents: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`,
  agentEventsStream: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/events/stream`,
  wakesSchedule: `/${CLUSTER_PROTOCOL_VERSION}/wakes/schedule`,

  operatorCluster: `/${CLUSTER_PROTOCOL_VERSION}/operator/cluster`,
  operatorWorkers: `/${CLUSTER_PROTOCOL_VERSION}/operator/workers`,
  operatorWorkerDrain: (workerId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/workers/${encodeURIComponent(workerId)}/drain`,
  operatorWorkerUndrain: (workerId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/workers/${encodeURIComponent(workerId)}/undrain`,
  operatorWorkerEvict: (workerId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/workers/${encodeURIComponent(workerId)}/evict`,
  operatorLeases: `/${CLUSTER_PROTOCOL_VERSION}/operator/leases`,
  operatorWakes: `/${CLUSTER_PROTOCOL_VERSION}/operator/wakes`,
  operatorWakeCancel: (wakeId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/wakes/${encodeURIComponent(wakeId)}`,
  operatorWorkerJoinScript: `/${CLUSTER_PROTOCOL_VERSION}/operator/workers/join-script`,
  operatorModelsTemplate: `/${CLUSTER_PROTOCOL_VERSION}/operator/models-template`,
  operatorAdminAgent: `/${CLUSTER_PROTOCOL_VERSION}/operator/admin-agent`,
  operatorMachines: `/${CLUSTER_PROTOCOL_VERSION}/operator/machines`,
  operatorMachineJoinScript: `/${CLUSTER_PROTOCOL_VERSION}/operator/machines/join-script`,
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
  agentSessions: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions`,
  agentSessionEvents: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events`,
  agentEventsStream: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/events/stream`,
  hasAgent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/has`,
} as const;

/**
 * Endpoints a *machine connector* serves (a8s → machine). Mirrors the
 * minimal shape of WORKER_PATHS but for a host that only lends an
 * execution surface: health + exec. spawn/stream come with M6.
 */
export const MACHINE_PATHS = {
  health: `/${CLUSTER_PROTOCOL_VERSION}/health`,
  exec: `/${CLUSTER_PROTOCOL_VERSION}/exec`,
} as const;

// ============================================================
// Auth helpers — minimal Bearer-token scheme
// ============================================================
//
// Two token classes share the same Bearer scheme but live in different
// scopes (path-based, never mixed):
//
//   - **Admin token**   — product / operator / berry-claw → a8s.
//     One shared secret per a8s deployment, set at startup (--admin-token).
//     Required on /v1/agents/*, /v1/wakes/*, /v1/operator/* (everything
//     not in /v1/workers/* and not /v1/health).
//   - **Worker token**  — minted per worker at registration, used both
//     directions (worker → a8s heartbeat/withdraw, a8s → worker for
//     run/stop/send/etc.).
//
// /v1/health is always unauthenticated. /v1/workers/register accepts the
// admin token (workers prove "I'm allowed to join this cluster" using the
// install-time bootstrap token); the response carries the worker token
// they'll use from then on.

export const WORKER_AUTH_HEADER = 'Authorization' as const;
export const WORKER_AUTH_SCHEME = 'Bearer' as const;
export const ADMIN_AUTH_HEADER = WORKER_AUTH_HEADER;
export const ADMIN_AUTH_SCHEME = WORKER_AUTH_SCHEME;

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

/** Aliases — same Bearer wire format, named for the admin-token scope. */
export const adminAuthHeader = workerAuthHeader;
export const parseAdminAuthHeader = parseWorkerAuthHeader;
