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
  /** Agent ids this worker currently has mounted. a8s renews their leases
   *  (only the holder can), keeping "brain alive ⇒ lease alive" true so an
   *  idle agent's lease doesn't expire under a running worker. */
  mountedAgents: z.array(z.string()).optional(),
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

// ---- Local MCP, projected as machine capabilities (defined first so
// the registration request can embed the manifest) -------------------
//
// The connector connects to the MCP servers in the machine's local
// .mcp.json and reports their tools as a manifest at registration. a8s
// stays MCP-agnostic: it stores the manifest verbatim and forwards a
// generic "invoke this MCP tool" call to the connector. The persistent
// MCP stdio connection lives entirely on the machine (connector ↔ server);
// only one-shot request/reply crosses a8s — exactly like exec.

/** One MCP tool the connector can proxy, in provider-call-safe shape. */
export const machineMcpToolSchema = z.object({
  /** MCP server id from the machine's .mcp.json (e.g. "playwright"). */
  server: z.string().min(1),
  /** Tool name as the upstream MCP server exposes it (dispatch key). */
  name: z.string().min(1),
  description: z.string().optional(),
  /** JSON-schema-ish input shape; forwarded to the model verbatim. */
  inputSchema: z.record(z.unknown()).optional(),
}).strict();
export type MachineMcpTool = z.infer<typeof machineMcpToolSchema>;

/**
 * The connector's full MCP capability manifest, reported at registration.
 * Flat list so a8s never has to understand MCP structure — it just hands
 * this back to the brain for tool projection.
 */
export const machineMcpManifestSchema = z.object({
  tools: z.array(machineMcpToolSchema).default([]),
}).strict();
export type MachineMcpManifest = z.infer<typeof machineMcpManifestSchema>;

/** a8s → connector: "invoke this MCP tool on your local server." */
export const machineMcpInvokeRequestSchema = z.object({
  server: z.string().min(1),
  /** Upstream (unprefixed) tool name. */
  name: z.string().min(1),
  input: z.record(z.unknown()).default({}),
}).strict();
export type MachineMcpInvokeRequest = z.infer<typeof machineMcpInvokeRequestSchema>;

export const machineMcpInvokeReplySchema = z.object({
  /** Stringified tool result content. */
  content: z.string(),
  isError: z.boolean().optional(),
}).strict();
export type MachineMcpInvokeReply = z.infer<typeof machineMcpInvokeReplySchema>;

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
   * and can proxy. Kept as a lightweight list for the operator view.
   */
  mcpServers: z.array(z.string().min(1)).optional().default([]),
  /**
   * Full MCP tool manifest. The connector connected to each local MCP
   * server, listed its tools, and reports them here so the brain can
   * project them into model-visible tools. a8s stores this verbatim and
   * stays MCP-agnostic. Omitted/empty when the machine has no local MCP.
   */
  mcpManifest: machineMcpManifestSchema.optional(),
  /**
   * Absolute path to the .mcp.json the connector reads (and rescans on
   * /reload). The connector declares it so a8s knows where to write when
   * landing a Hand recipe — the machine owns its env and names its own
   * config location. Omitted when MCP is disabled on the machine.
   */
  mcpConfigPath: z.string().min(1).optional(),
}).strict();
export type MachineRegistrationRequest = z.infer<typeof machineRegistrationRequestSchema>;

export const machineRegistrationResponseSchema = z.object({
  machineId: z.string().min(1),
  heartbeatTtlMs: z.number().int().positive(),
  /** Token the connector uses on subsequent calls; a8s uses it to call back. */
  machineToken: z.string().min(1),
}).strict();
export type MachineRegistrationResponse = z.infer<typeof machineRegistrationResponseSchema>;

/**
 * Heartbeat body. Optionally re-reports the machine's current MCP capability
 * so a8s reflects changes made after registration (e.g. a8s remotely wrote a
 * new .mcp.json over /exec and the connector reloaded). Omitted fields leave
 * the stored capability untouched — a plain `{}` heartbeat is still valid.
 */
export const machineHeartbeatRequestSchema = z.object({
  mcpServers: z.array(z.string().min(1)).optional(),
  mcpManifest: machineMcpManifestSchema.optional(),
}).strict();
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

/** One MCP server the machine exposes, with a health hint for the wizard. */
export const machineMcpServerInfoSchema = z.object({
  /** Server id from the machine's .mcp.json (e.g. "playwright"). */
  server: z.string().min(1),
  /** Tools the connector listed from it. >0 ⇒ connected & healthy. */
  toolCount: z.number().int().nonnegative(),
  /** True when the connector currently holds a live connection to it. */
  healthy: z.boolean(),
}).strict();
export type MachineMcpServerInfo = z.infer<typeof machineMcpServerInfoSchema>;

/** Operator view of one registered machine. */
export const operatorMachineSchema = z.object({
  machineId: z.string().min(1),
  state: z.enum(['active', 'withdrawn', 'expired']),
  callbackUrl: z.string(),
  platform: z.string().optional(),
  labels: z.record(z.string()).optional(),
  mcpServers: z.array(z.string()).default([]),
  /** Count of MCP tools the machine proxies (manifest size). UI hint. */
  mcpToolCount: z.number().int().nonnegative().default(0),
  /** Per-server breakdown with health — drives the Hand wizard's MCP step. */
  mcpServerDetails: z.array(machineMcpServerInfoSchema).default([]),
  registeredAt: z.number().int(),
  heartbeatAt: z.number().int(),
  heartbeatExpiresAt: z.number().int(),
}).strict();
export type OperatorMachine = z.infer<typeof operatorMachineSchema>;

export const operatorMachineListResponseSchema = z.object({
  machines: z.array(operatorMachineSchema),
}).strict();
export type OperatorMachineListResponse = z.infer<typeof operatorMachineListResponseSchema>;

/**
 * One MCP server entry in a machine's `.mcp.json`, in the Claude Code / Cursor
 * shape. Kept permissive (passthrough) so a8s stays MCP-agnostic: it transports
 * the fragment to the connector verbatim and the connector's loader is the
 * single interpreter. `env` values should be env var name references
 * (`${GITHUB_TOKEN}`), not secrets — the value is the machine owner's asset.
 */
export const mcpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'http', 'sse', 'streamable_http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
}).passthrough();
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Operator → a8s: "set this machine's MCP servers." a8s writes the map into the
 * machine's `.mcp.json` over the exec broker, runs any install commands, then
 * asks the connector to /reload. This is the ONLY place MCP config is authored
 * — the machine is the single source of truth. Replaces the whole map (the
 * connector rescans afterward), so the UI sends the full desired set.
 */
export const machineSetMcpRequestSchema = z.object({
  mcpServers: z.record(mcpServerConfigSchema),
  /** Shell commands to run on the machine before reload (e.g. `npm i -g ...`). */
  installCommands: z.array(z.string().min(1)).default([]),
  /** Absolute path to write; defaults to the connector-reported `.mcp.json`. */
  configPath: z.string().min(1).optional(),
}).strict();
export type MachineSetMcpRequest = z.infer<typeof machineSetMcpRequestSchema>;

/** Result of setting machine MCP — echoes the connector's post-reload capability. */
export const machineSetMcpResponseSchema = z.object({
  machineId: z.string().min(1),
  configPath: z.string().min(1),
  mcpServers: z.array(z.string()),
  mcpManifest: machineMcpManifestSchema,
}).strict();
export type MachineSetMcpResponse = z.infer<typeof machineSetMcpResponseSchema>;

/** a8s → operator: a machine's current `.mcp.json` mcpServers map (read over exec). */
export const machineGetMcpResponseSchema = z.object({
  machineId: z.string().min(1),
  configPath: z.string().min(1).nullable(),
  mcpServers: z.record(mcpServerConfigSchema),
}).strict();
export type MachineGetMcpResponse = z.infer<typeof machineGetMcpResponseSchema>;

// ============================================================
// Hand recipes — capability bundles assembled over a machine
// ============================================================
//
// A Hand recipe is one Hand in the market, assembled as a pipeline:
//   1. pick an ENVIRONMENT — a machine (provides shell exec).
//   2. pick TOOL GROUPS — the common-tool families to grant (workspace, web).
//   3. reference a subset of the machine's exposed MCP servers.
// The Hand carries NO MCP config — the machine's `.mcp.json` is the single
// source of truth for what MCP exists (set on the Machines page). Many Hands
// can target the same machine; the basis is free.
//
// Selecting a Hand onto an agent grants that machine (merges `machineId` into
// the agent's `labels.machines`; the agent gets `machine_<id>_exec` and reaches
// the machine's MCP via berry-mcp). There is no "land" step.

/** Common-tool families a Hand can grant. `exec` (machine shell) is implicit in
 *  every machine Hand; these are the env-level extras the SDK projects. */
export const HAND_TOOL_GROUPS = ['workspace', 'web'] as const;
export const handToolGroupSchema = z.enum(HAND_TOOL_GROUPS);
export type HandToolGroup = z.infer<typeof handToolGroupSchema>;

export const handRecipeSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'recipe id must be kebab-case'),
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * The machine (environment) this Hand uses. Selecting the Hand merges this
   * into the agent's `labels.machines`. Many Hands may share one machine.
   */
  machineId: z.string().min(1),
  /**
   * Free-assembly convenience grouping for the market view (e.g. `系统预装`).
   * A label only — it never restricts a recipe's source or contents.
   */
  group: z.string().min(1).optional(),
  /**
   * Common tool families this Hand grants (besides the machine's always-on
   * `exec`). `workspace` = file/shell/search; `web` = fetch/search. Empty = a
   * pure exec/MCP Hand.
   */
  toolGroups: z.array(handToolGroupSchema).default([]),
  /**
   * Subset of the machine's exposed MCP server names this Hand grasps. These
   * are references — the actual MCP config lives in the machine's `.mcp.json`
   * (the single source of truth). Empty = no MCP for this Hand.
   */
  mcpServerRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type HandRecipe = z.infer<typeof handRecipeSchema>;

export const handRecipeListResponseSchema = z.object({
  recipes: z.array(handRecipeSchema),
}).strict();
export type HandRecipeListResponse = z.infer<typeof handRecipeListResponseSchema>;

/** Register/update a recipe (operator). Same shape as the stored recipe. */
export const handRecipeRegisterRequestSchema = handRecipeSchema;
export type HandRecipeRegisterRequest = z.infer<typeof handRecipeRegisterRequestSchema>;

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
  /** Owning product (from labels.owner). Null/absent = unowned (legacy/operator). */
  owner: z.string().nullable().optional(),
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

// ----- Turn streaming (send as an SSE response) -----
// `/send` streams the turn instead of blocking: while the turn runs it emits
// the live AgentEvents (text_delta, tool_call, …) as SSE frames, then a
// single terminal frame — `done` carrying the final SendResponse, or
// `error`. This is the ONLY output path for live token-level increments
// (the durable /events/stream only carries persisted, replayable
// SessionEvents — it must stay replayable, so ephemeral deltas never go
// there). One turn = one stream = one source of truth.
//
// Frame `type` values:
//   - 'event' : data = an opaque SDK AgentEvent (text_delta/tool_call/…).
//   - 'done'  : data = SendResponse (sessionId + final turn result).
//   - 'error' : data = { message }.
// The SSE `event:` field carries the same `type`; `data:` is the JSON below.

export const sendStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('done'), response: sendResponseSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
]);
export type SendStreamFrame = z.infer<typeof sendStreamFrameSchema>;

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
// Agent configuration & introspection (product → a8s → worker)
// ============================================================
// All of these already exist on the SDK's AgentSession / ManagedAgentRuntime
// in-process; these wire shapes expose them over HTTP so a remote product
// (a BFF with no engine of its own) can configure and inspect an agent
// whose runtime + on-disk home live on a worker's machine. a8s proxies to
// the owning worker exactly like /send.

/**
 * Agent "home" documents the product may read/write. Each maps to an
 * AgentSession method pair. Kept as a small enum (not arbitrary paths) so
 * the worker never has to sandbox a free-form path: the SDK owns where
 * each doc physically lives in the agent home.
 */
export const agentHomeDocSchema = z.enum(['memory', 'instructions', 'project-knowledge']);
export type AgentHomeDoc = z.infer<typeof agentHomeDocSchema>;

export const agentHomeReadResponseSchema = z.object({
  doc: agentHomeDocSchema,
  /** File path on the worker (informational) — null for project-knowledge aggregate. */
  path: z.string().nullable(),
  content: z.string(),
  /** project-knowledge returns multiple files; present only for that doc. */
  files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).optional(),
  /** project root, present only for project-knowledge. */
  project: z.string().nullable().optional(),
}).strict();
export type AgentHomeReadResponse = z.infer<typeof agentHomeReadResponseSchema>;

export const agentHomeWriteRequestSchema = z.object({
  content: z.string(),
}).strict();
export type AgentHomeWriteRequest = z.infer<typeof agentHomeWriteRequestSchema>;

export const agentHomeWriteResponseSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
}).strict();
export type AgentHomeWriteResponse = z.infer<typeof agentHomeWriteResponseSchema>;

/**
 * Mutate live agent spec fields. Every field optional; only the present
 * ones are applied. These map to runtime setters that take effect on the
 * next turn without dropping in-memory session state.
 */
export const agentSpecPatchRequestSchema = z.object({
  /** tier:X / model:X / bare model id — resolved by the worker's registry. */
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().optional(),
  /** Tool names refused regardless of safety guard. Empty array clears. */
  toolDenylist: z.array(z.string()).optional(),
  /**
   * Built-in Hand selection (e.g. ['workspace','web']). Writes through to
   * agent.json's hands.builtin and re-resolves the live Hand set, so adding
   * or removing a Hand is just a config edit — no recreate, no restart.
   * Empty array = a pure-API/collaboration agent (no built-in Hands).
   */
  hands: z.array(z.string()).optional(),
}).strict();
export type AgentSpecPatchRequest = z.infer<typeof agentSpecPatchRequestSchema>;

export const agentSpecPatchResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
export type AgentSpecPatchResponse = z.infer<typeof agentSpecPatchResponseSchema>;

/** Live status snapshot (maps to AgentSession.getStatus). */
export const agentStatusResponseSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
}).strict();
export type AgentStatusResponse = z.infer<typeof agentStatusResponseSchema>;

/** Context-window usage (maps to AgentSession.contextSize). */
export const agentContextSizeResponseSchema = z.object({
  current: z.number().int().nonnegative(),
  window: z.number().int().nonnegative(),
}).strict();
export type AgentContextSizeResponse = z.infer<typeof agentContextSizeResponseSchema>;

/**
 * Product-facing slice of the SDK AgentSnapshot. The snapshot lives on the
 * worker (the agent's runtime); this exposes what a product BFF needs to
 * show an agent 4+1-natively: its Hands (id/kind/displayName/capabilities),
 * loaded skills, the flattened tool names (model projection), and the live
 * model/provider + status. The full SDK snapshot has more (compaction,
 * middleware, etc.) — those stay SDK-internal; the wire carries only the
 * product view. Hands are the structural truth; `tools` is their projection.
 */
export const agentSnapshotResponseSchema = z.object({
  model: z.string(),
  provider: z.string(),
  status: z.string(),
  statusDetail: z.string().optional(),
  hands: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    displayName: z.string().optional(),
    capabilities: z.array(z.string()),
  }).strict()),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
  }).strict()),
  /** Flattened tool names the model sees (projection of all hands). */
  tools: z.array(z.string()),
}).strict();
export type AgentSnapshotResponse = z.infer<typeof agentSnapshotResponseSchema>;

// ----- Skill install/remove/list (product → a8s → worker home) -----
// Skills are files in the agent's home (home/skills/<name>/SKILL.md +
// optional extras). a8s does NOT store or parse skill content — it proxies
// the write to the worker that owns the home, exactly like the home docs.
// Content source is the caller's concern (system skills, ClawHub, agent
// self-authored); the wire just carries opaque content.

export const skillInstallRequestSchema = z.object({
  name: z.string().min(1),
  /** Full SKILL.md content (frontmatter + body). */
  content: z.string(),
  /** Optional extra files under the skill dir (scripts/, references/). */
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  }).strict()).optional(),
}).strict();
export type SkillInstallRequest = z.infer<typeof skillInstallRequestSchema>;

export const skillInstallResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
}).strict();
export type SkillInstallResponse = z.infer<typeof skillInstallResponseSchema>;

export const skillRemoveResponseSchema = z.object({
  removed: z.boolean(),
}).strict();
export type SkillRemoveResponse = z.infer<typeof skillRemoveResponseSchema>;

export const skillListResponseSchema = z.object({
  /** Installed skill dir names. Index meta (description) comes via snapshot. */
  names: z.array(z.string()),
}).strict();
export type SkillListResponse = z.infer<typeof skillListResponseSchema>;

// ----- Skill registry (operator: a8s's catalog of installable skills) -----
// a8s is the market: it lists skills (built-ins shipped with @berry-agent/
// a8s-admin + operator-registered ones) and installs a chosen skill onto an
// agent by proxying its content to the per-agent /skills endpoint. Per the
// settled invariant, a8s carries skill content VERBATIM — it never parses,
// translates, or rewrites the SKILL.md. `name`/`description` are display
// metadata declared alongside the content, not derived by transforming it.

/** Listing metadata for one registry skill (no content — kept light). */
export const operatorSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** True for skills a8s ships out of the box (read-only in the registry). */
  builtin: z.boolean().default(false),
  /** Count of extra files (scripts/, references/) bundled with the skill. */
  extraFileCount: z.number().int().nonnegative().default(0),
}).strict();
export type OperatorSkill = z.infer<typeof operatorSkillSchema>;

export const operatorSkillListResponseSchema = z.object({
  skills: z.array(operatorSkillSchema),
}).strict();
export type OperatorSkillListResponse = z.infer<typeof operatorSkillListResponseSchema>;

/** Full registry skill (metadata + verbatim content + extra files). */
export const operatorSkillDetailSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  builtin: z.boolean().default(false),
  /** Full SKILL.md content (frontmatter + body), verbatim. */
  content: z.string(),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  }).strict()).default([]),
}).strict();
export type OperatorSkillDetail = z.infer<typeof operatorSkillDetailSchema>;

/** Register/update an operator skill. `builtin` is forced false server-side. */
export const operatorSkillRegisterRequestSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'skill name must be kebab-case'),
  description: z.string().min(1),
  content: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  }).strict()).optional(),
}).strict();
export type OperatorSkillRegisterRequest = z.infer<typeof operatorSkillRegisterRequestSchema>;

/** Result of installing a registry skill onto an agent. */
export const operatorSkillInstallResponseSchema = z.object({
  ok: z.literal(true),
  agentId: z.string().min(1),
  name: z.string().min(1),
}).strict();
export type OperatorSkillInstallResponse = z.infer<typeof operatorSkillInstallResponseSchema>;

// ============================================================
// Product credentials — operator issues/revokes scoped tokens
// ============================================================
// a8s is multi-tenant: a product authenticates with a `bp_…` token that
// scopes it to its own agents. The operator issues/rotates/revokes these.
// The full token value is returned ONLY at issue time (it isn't stored in
// recoverable form for listing — list returns metadata without the token).

/** One product credential as surfaced to the operator (no token value). */
export const productCredentialInfoSchema = z.object({
  product: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  label: z.string().optional(),
}).strict();
export type ProductCredentialInfo = z.infer<typeof productCredentialInfoSchema>;

export const productCredentialListResponseSchema = z.object({
  credentials: z.array(productCredentialInfoSchema),
}).strict();
export type ProductCredentialListResponse = z.infer<typeof productCredentialListResponseSchema>;

/** Issue (or rotate) a product's credential. */
export const productCredentialIssueRequestSchema = z.object({
  product: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'product must be kebab-case'),
  label: z.string().min(1).optional(),
}).strict();
export type ProductCredentialIssueRequest = z.infer<typeof productCredentialIssueRequestSchema>;

/** The issue response carries the token ONCE — the operator must copy it now. */
export const productCredentialIssueResponseSchema = z.object({
  product: z.string().min(1),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  label: z.string().optional(),
}).strict();
export type ProductCredentialIssueResponse = z.infer<typeof productCredentialIssueResponseSchema>;

// ============================================================
// Audit log query — operator reads the append-only action log
// ============================================================

/** One audit row (mirrors a8s-server's AuditEntry). */
export const auditEntrySchema = z.object({
  ts: z.number().int().nonnegative(),
  action: z.string().min(1),
  actor: z.string().min(1),
  sourceIp: z.string().optional(),
  target: z.string().optional(),
  outcome: z.enum(['ok', 'err']),
  details: z.record(z.unknown()).optional(),
}).strict();
export type AuditEntryWire = z.infer<typeof auditEntrySchema>;

export const auditQueryResponseSchema = z.object({
  entries: z.array(auditEntrySchema),
  /** True if the result was capped at `limit` (more rows exist). */
  truncated: z.boolean(),
}).strict();
export type AuditQueryResponse = z.infer<typeof auditQueryResponseSchema>;

/** Pause the current turn. */
export const agentPauseRequestSchema = z.object({
  reason: z.string().optional(),
}).strict();
export type AgentPauseRequest = z.infer<typeof agentPauseRequestSchema>;

export const agentPauseResponseSchema = z.object({
  paused: z.boolean(),
  status: z.string(),
  detail: z.string().optional(),
}).strict();
export type AgentPauseResponse = z.infer<typeof agentPauseResponseSchema>;

/** Queue a human interjection for the running turn. */
export const agentInterjectRequestSchema = z.object({
  text: z.string().min(1),
}).strict();
export type AgentInterjectRequest = z.infer<typeof agentInterjectRequestSchema>;

export const agentInterjectResponseSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
}).strict();
export type AgentInterjectResponse = z.infer<typeof agentInterjectResponseSchema>;

// ----- Session write operations (product → a8s → worker) -----
// The read side (list sessions, page events) already exists above. These
// are the mutating ops: create/delete/clear a session, load one full view,
// read its todos. All map 1:1 to ManagedAgentRuntime methods (the same
// object AgentSession wraps in-process). A full session view carries the
// rendered message timeline, which is a rich SDK shape — kept opaque here
// (z.record) exactly like raw session events, so the protocol stays thin.

/** One rendered session view (id + metadata + opaque messages). */
export const agentSessionViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  agentId: z.string().optional(),
  status: z.string(),
  /** Rendered message timeline — opaque SDK shape (AgentChatMessage[]). */
  messages: z.array(z.record(z.unknown())),
}).strict();
export type AgentSessionViewWire = z.infer<typeof agentSessionViewSchema>;

/** POST .../sessions → create a fresh session, returns its view. */
export const sessionCreateResponseSchema = z.object({
  session: agentSessionViewSchema,
}).strict();
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;

/** GET .../sessions/:id → one full view, or null if absent. */
export const sessionViewResponseSchema = z.object({
  session: agentSessionViewSchema.nullable(),
}).strict();
export type SessionViewResponse = z.infer<typeof sessionViewResponseSchema>;

/** DELETE .../sessions/:id → removed; flags whether it was the active one. */
export const sessionDeleteResponseSchema = z.object({
  sessionId: z.string(),
  wasActive: z.boolean(),
}).strict();
export type SessionDeleteResponse = z.infer<typeof sessionDeleteResponseSchema>;

/** POST .../sessions/:id/clear → cleared; returns the (possibly fresh) view. */
export const sessionClearResponseSchema = z.object({
  sessionId: z.string(),
  session: agentSessionViewSchema.nullable(),
}).strict();
export type SessionClearResponse = z.infer<typeof sessionClearResponseSchema>;

/** GET .../sessions/:id/todos → the session's todo items. */
export const sessionTodosResponseSchema = z.object({
  todos: z.array(z.object({
    text: z.string(),
    done: z.boolean().optional(),
  }).strict()),
}).strict();
export type SessionTodosResponse = z.infer<typeof sessionTodosResponseSchema>;

/** POST .../sessions/:id/events → append one event draft to the log.
 *  Draft + persisted event are opaque SDK shapes (z.record), like the read
 *  side. Used by products to record orchestration events (e.g. approval
 *  request/decision) onto the durable session log on the worker. */
export const sessionAppendEventRequestSchema = z.object({
  event: z.record(z.unknown()),
}).strict();
export type SessionAppendEventRequest = z.infer<typeof sessionAppendEventRequestSchema>;

export const sessionAppendEventResponseSchema = z.object({
  /** The persisted event (with id/timestamp), or null if not appended. */
  event: z.record(z.unknown()).nullable(),
}).strict();
export type SessionAppendEventResponse = z.infer<typeof sessionAppendEventResponseSchema>;

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

// ---- Models probe: pull a provider's live model list ----------------
// The UI can't call a provider's /models directly (CORS + it would leak
// the key into the browser), so a8s proxies it: the operator types
// baseUrl + apiKey, a8s calls the provider and returns the model ids.
// a8s does NOT persist anything here — probing is stateless; the key is
// only saved when the operator saves the template.

export const modelsProbeRequestSchema = z.object({
  /** Built-in preset id (anthropic / openai / moonshot / ...) or omitted for a raw/custom provider. */
  presetId: z.string().min(1).optional(),
  /** Override the preset's base URL, or the full base URL for a raw provider. */
  baseUrl: z.string().url().optional(),
  /** Provider API key. Used only for this call; never stored by the probe. */
  apiKey: z.string().min(1),
  /** Auth flavor when there's no preset. Defaults to 'openai' (Bearer). */
  type: z.enum(['anthropic', 'openai']).optional(),
}).strict();
export type ModelsProbeRequest = z.infer<typeof modelsProbeRequestSchema>;

export const modelsProbeResponseSchema = z.object({
  /** Sorted, deduped model ids the provider reports. */
  models: z.array(z.string()),
  /** 'live' = fetched from the provider; 'known' = fell back to a cached list. */
  source: z.enum(['live', 'known']),
  /** Non-fatal note when the live fetch failed and a cached list was used. */
  warning: z.string().optional(),
}).strict();
export type ModelsProbeResponse = z.infer<typeof modelsProbeResponseSchema>;

/** One built-in provider preset surfaced to the UI's "add provider" form. */
export const modelsPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  type: z.enum(['anthropic', 'openai']),
  baseUrl: z.string(),
  /** True when the provider exposes a live model-list endpoint. */
  canList: z.boolean(),
  /** Where the operator gets their API key, if the preset declares it. */
  apiKeyDocsUrl: z.string().optional(),
}).strict();
export type ModelsPreset = z.infer<typeof modelsPresetSchema>;

export const modelsPresetListResponseSchema = z.object({
  presets: z.array(modelsPresetSchema),
}).strict();
export type ModelsPresetListResponse = z.infer<typeof modelsPresetListResponseSchema>;


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

// ============================================================
// Usage / consumption (read-only rollup from each worker's observe.db)
// ============================================================
// The observe package already records every inference (tokens + cost) on
// each worker's private observe.db and rolls it up to session/agent. These
// schemas carry that agent-level rollup over the wire so a8s can proxy it
// (per agent) and fan-in aggregate it (per cluster) without holding any
// usage state itself. Shape mirrors observe's AgentMetrics — declared here
// rather than imported, so cluster-protocol stays dependency-free.

export const agentUsageToolStatSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
}).strict();

/** Per-model cost/token split — the model rung of the consumption layering. */
export const agentUsageModelStatSchema = z.object({
  model: z.string(),
  calls: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

/** Per-day cost/call point — the time rung of the consumption layering. */
export const agentUsageDailyStatSchema = z.object({
  date: z.string(),
  calls: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
}).strict();

export const agentUsageSchema = z.object({
  agentId: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  avgSessionCost: z.number().nonnegative(),
  topTools: z.array(agentUsageToolStatSchema).default([]),
  modelUsage: z.record(z.number().int().nonnegative()).default({}),
  // Real per-model cost/token split this agent accounts for (sorted by cost).
  // Carries the same data over the wire so a8s can fan-in aggregate a cluster
  // model breakdown without holding any usage state itself.
  modelBreakdown: z.array(agentUsageModelStatSchema).default([]),
  // Per-day cost/call trend (UTC YYYY-MM-DD buckets, ascending). The time rung
  // of the consumption layering: carries each agent's daily spend over the wire
  // so a8s can fan these in by date into a cluster trend — same upward-only
  // rule, never re-recorded.
  dailyTrend: z.array(agentUsageDailyStatSchema).default([]),
}).strip();
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/** Worker's reply for GET /agents/:id/usage. usage=null → no recorded data. */
export const agentUsageResponseSchema = z.object({
  present: z.boolean(),
  usage: agentUsageSchema.nullable(),
}).strict();
export type AgentUsageResponse = z.infer<typeof agentUsageResponseSchema>;

/** a8s operator rollup for GET /operator/usage — cluster totals + per-agent rows. */
export const operatorUsageAgentRowSchema = agentUsageSchema.extend({
  /** Owning product (labels.owner), null when operator-created/unowned. */
  owner: z.string().nullable(),
  workerId: z.string().nullable(),
}).strip();
export type OperatorUsageAgentRow = z.infer<typeof operatorUsageAgentRowSchema>;

export const operatorUsageResponseSchema = z.object({
  totals: z.object({
    agentCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict(),
  /** Per-product subtotals, aggregated upward from agent rows (no re-recording). */
  byProduct: z.array(z.object({
    product: z.string(),
    agentCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict()),
  /** Per-model cluster rollup — fan-in over every agent's modelBreakdown. */
  byModel: z.array(z.object({
    model: z.string(),
    agentCount: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict()).default([]),
  /**
   * Cluster cost trend by day — fan-in over every agent's dailyTrend, summed
   * per UTC date and sorted ascending in time. The time rung of the layering:
   * the totals say "how much", this says "how fast", so an operator sees spend
   * accelerating or flattening at a glance. Pure upward aggregation, never
   * re-recorded — each agent already owns its daily split.
   */
  trend: z.array(z.object({
    date: z.string(),
    calls: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
  }).strict()).default([]),
  agents: z.array(operatorUsageAgentRowSchema),
}).strict();
export type OperatorUsageResponse = z.infer<typeof operatorUsageResponseSchema>;

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
  agentSession: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  agentSessionClear: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/clear`,
  agentSessionTodos: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/todos`,
  agentEventsStream: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/events/stream`,
  agentHomeDoc: (agentId: string, doc: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/home/${encodeURIComponent(doc)}`,
  agentSpec: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/spec`,
  agentStatus: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/status`,
  agentSnapshot: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/snapshot`,
  agentSkills: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/skills`,
  agentSkill: (agentId: string, name: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
  agentContextSize: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/context-size`,
  /** Per-agent consumption rollup (proxied to the owning worker's observe.db). */
  agentUsage: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/usage`,
  agentPause: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/pause`,
  agentInterject: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/interject`,
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
  operatorModelsProbe: `/${CLUSTER_PROTOCOL_VERSION}/operator/models/probe`,
  operatorModelsPresets: `/${CLUSTER_PROTOCOL_VERSION}/operator/models/presets`,
  operatorAdminAgent: `/${CLUSTER_PROTOCOL_VERSION}/operator/admin-agent`,
  operatorMachines: `/${CLUSTER_PROTOCOL_VERSION}/operator/machines`,
  operatorMachineJoinScript: `/${CLUSTER_PROTOCOL_VERSION}/operator/machines/join-script`,
  /** Read/write a machine's .mcp.json (the single source of truth for MCP). */
  operatorMachineMcpConfig: (machineId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/machines/${encodeURIComponent(machineId)}/mcp-config`,
  operatorHandRecipes: `/${CLUSTER_PROTOCOL_VERSION}/operator/hand-recipes`,
  operatorHandRecipe: (recipeId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/hand-recipes/${encodeURIComponent(recipeId)}`,
  /** Skill registry (a8s's catalog of installable skills). */
  operatorSkills: `/${CLUSTER_PROTOCOL_VERSION}/operator/skills`,
  operatorSkill: (name: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/skills/${encodeURIComponent(name)}`,
  /** Install a registry skill onto an agent: POST .../agents/:id/skills/:name */
  operatorAgentInstallSkill: (agentId: string, name: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
  /** Product-scoped credentials (issue/revoke/list bp_… tokens). */
  operatorCredentials: `/${CLUSTER_PROTOCOL_VERSION}/operator/credentials`,
  operatorCredential: (product: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/operator/credentials/${encodeURIComponent(product)}`,
  /** Operator audit log query. */
  operatorAudit: `/${CLUSTER_PROTOCOL_VERSION}/operator/audit`,
  /** Cluster-wide consumption rollup (fan-in over workers' observe.db). */
  operatorUsage: `/${CLUSTER_PROTOCOL_VERSION}/operator/usage`,
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
  agentSession: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  agentSessionClear: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/clear`,
  agentSessionTodos: (agentId: string, sessionId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/todos`,
  agentEventsStream: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/events/stream`,
  hasAgent: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/has`,
  agentHomeDoc: (agentId: string, doc: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/home/${encodeURIComponent(doc)}`,
  agentSpec: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/spec`,
  agentStatus: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/status`,
  agentSnapshot: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/snapshot`,
  agentSkills: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/skills`,
  agentSkill: (agentId: string, name: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`,
  agentContextSize: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/context-size`,
  /** Per-agent consumption rollup straight from this worker's observe.db. */
  agentUsage: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/usage`,
  agentPause: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/pause`,
  agentInterject: (agentId: string) =>
    `/${CLUSTER_PROTOCOL_VERSION}/agents/${encodeURIComponent(agentId)}/interject`,
} as const;

/**
 * Endpoints a *machine connector* serves (a8s → machine). Mirrors the
 * minimal shape of WORKER_PATHS but for a host that only lends an
 * execution surface: health + exec + mcp/invoke. Background-process
 * spawn/streaming is intentionally not offered (a connector's job is
 * one-shot exec + MCP proxy, not long-lived process management).
 */
export const MACHINE_PATHS = {
  health: `/${CLUSTER_PROTOCOL_VERSION}/health`,
  exec: `/${CLUSTER_PROTOCOL_VERSION}/exec`,
  mcpInvoke: `/${CLUSTER_PROTOCOL_VERSION}/mcp/invoke`,
  /** Re-read .mcp.json and rebuild live MCP connections without a restart.
   *  Called after a8s writes a new config over /exec. */
  reload: `/${CLUSTER_PROTOCOL_VERSION}/reload`,
} as const;

/** Reply from POST /reload — the connector's MCP capability after rescanning. */
export const machineReloadReplySchema = z.object({
  mcpServers: z.array(z.string().min(1)),
  mcpManifest: machineMcpManifestSchema,
}).strict();
export type MachineReloadReply = z.infer<typeof machineReloadReplySchema>;

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
