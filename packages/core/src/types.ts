// ============================================================
// Berry Agent SDK — Core Type Definitions
// ============================================================

// ----- Messages (Internal Format) -----
// This is Berry's canonical message format.
// Provider adapters convert to/from wire format.

export type Role = 'user' | 'assistant';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ImageContent {
  type: 'image';
  /** Base64-encoded image data */
  data: string;
  /** Media type, e.g., 'image/jpeg', 'image/png', 'image/webp', 'image/gif' */
  mediaType: string;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ThinkingContent | ImageContent;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
  /** Whether this message has been compacted */
  compacted?: boolean;
  /** Timestamp */
  createdAt?: number;
}

// ----- Tools -----

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolRegistration {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Content for the LLM (may differ from what user sees) */
  forLLM?: string;
  /** Content for the user (optional, display only) */
  forUser?: string;
}

// ----- Provider -----

export type ProviderType = 'anthropic' | 'openai';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Anthropic extended thinking budget (0 = disabled) */
  thinkingBudget?: number;
}

/**
 * Pluggable provider resolver — the hook point for failover / multi-provider
 * bindings that live OUTSIDE core (see @berry-agent/models).
 *
 * Core never implements failover policy. It only asks "which provider config
 * do I use right now?" and reports errors back so the resolver can decide
 * whether to rotate, retry, or give up.
 *
 * Consumers that don't need failover can keep passing a plain ProviderConfig
 * to `new Agent({ provider })` — that path is never going away.
 */
export interface ProviderResolver {
  /** Unique id for logging. */
  readonly id: string;

  /**
   * Return the provider config to use for the next call.
   * Called at the start of every provider request; cheap to invoke.
   */
  resolve(): ProviderConfig;

  /**
   * Called by the agent loop when a provider call fails. The resolver may
   * rotate its internal pointer so the next `resolve()` returns a different
   * provider. If the resolver throws, the agent propagates the original error.
   *
   * `isTransient` is a hint from core: 4xx auth / 402 / 429 / 5xx / network.
   * Resolvers decide their own policy.
   */
  reportError?(err: unknown, hints?: { isTransient?: boolean; statusCode?: number }): void;

  /**
   * Optional — reset state (e.g. when a new session starts). Core calls this
   * at session boundary if defined. Useful for per-session stickiness.
   */
  resetForSession?(sessionId: string): void;
}

/** Convenience: input accepted by Agent.provider / AgentCreateConfig.provider. */
export type ProviderInput = ProviderConfig | ProviderResolver;

/** Narrow a ProviderInput into a ProviderResolver form (even for static configs). */
export function toProviderResolver(input: ProviderInput): ProviderResolver {
  if ('resolve' in input && typeof (input as ProviderResolver).resolve === 'function') {
    return input as ProviderResolver;
  }
  const cfg = input as ProviderConfig;
  return {
    id: `static:${cfg.type}:${cfg.model}`,
    resolve: () => cfg,
  };
}

export interface ProviderRequest {
  /** System prompt blocks (split for cache optimization) */
  systemPrompt: string[];
  messages: Message[];
  tools?: ToolDefinition[];
  /** Abort signal */
  signal?: AbortSignal;
  /** Force JSON schema output (structured output) */
  responseFormat?: JsonSchema;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: TokenUsage;
  rawUsage?: Record<string, unknown>;
  /** Provider-side wire format request (for observe/debugging) */
  rawRequest?: Record<string, unknown>;
  /** Provider-side wire format response (for observe/debugging) */
  rawResponse?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

// ----- Session -----

export interface Session {
  id: string;
  messages: Message[];
  systemPrompt: string[];
  createdAt: number;
  lastAccessedAt: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  cwd: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  compactionCount: number;
  /** Last known input token count from the most recent API response (for compaction decisions). */
  lastInputTokens?: number;
  /** Minimal per-session todo state kept outside the system prompt. */
  todo?: SessionTodoState;
}

export interface TodoItem {
  text: string;
  done?: boolean;
}

export interface SessionTodoState {
  items: TodoItem[];
  updatedAt: number;
}

// ----- Agent Config -----

export interface AgentConfig {
  /**
   * Provider config, or a resolver (from @berry-agent/models or a custom
   * failover implementation). Static configs still work unchanged.
   */
  provider: ProviderInput;
  /** Optional injected provider instance (useful for tests/custom providers) */
  providerInstance?: Provider;
  /** System prompt — string or array of blocks (for cache optimization) */
  systemPrompt: string | string[];
  tools?: ToolRegistration[];
  /** Directories containing skills (each subdirectory has a SKILL.md). */
  skillDirs?: string[];
  cwd?: string;
  /** Compaction config */
  compaction?: CompactionConfig;
  /** Session store (default: in-memory) */
  sessionStore?: SessionStore;
  /** Event handler for streaming / logging */
  onEvent?: (event: AgentEvent) => void;
  /** Middleware pipeline (runs in order) */
  middleware?: Middleware[];
  /**
   * Tool execution guard. Called before every tool execution.
   * Return { action: 'allow' } to proceed, { action: 'deny', reason } to block,
   * or { action: 'modify', input } to proceed with modified input.
   *
   * If not set, all tool calls are allowed (no guard).
   *
   * Use this to plug in any permission strategy:
   * - Static rules (deny dangerous tools)
   * - LLM-based safety classifier
   * - User confirmation UI
   * - Directory scoping
   */
  toolGuard?: ToolGuard;
  /**
   * Event log store for append-only session event recording.
   * When set, every action in query() is appended to the event log,
   * and context windows are rebuilt from the log via ContextStrategy.
   * When not set, behavior is identical to the original messages[] approach.
   */
  eventLogStore?: import('./event-log/types.js').EventLogStore;
  /**
   * Agent workspace directory. When set, enables event log, memory, and workspace features.
   * Auto-initializes workspace structure on first use (unless autoInit is false).
   */
  workspace?: string;
  /** Pluggable MemoryProvider — contributes memory tools (search, get, …) to the agent. */
  memory?: import('./memory/provider.js').MemoryProvider;
  /** Project root directory (optional binding for shared project context). */
  project?: string;
  /** Enable built-in delegate tool (default: true for top-level agents, always false for sub-agents) */
  enableDelegate?: boolean;
  /**
   * Enable built-in spawn_agent tool.
   * @deprecated No longer has any effect. spawn_agent was removed from core;
   * persistent sub-agent creation moved to @berry-agent/team as
   * `spawn_teammate` (leader-only). The field is kept for backward-compat
   * typing; pass `false` or omit — either is a no-op now.
   */
  enableSpawn?: boolean;
  /** Custom compaction strategy (overrides the default 7-layer pipeline). */
  compactionStrategy?: import('./compaction/types.js').CompactionStrategy;
  /** Called at the start of each query (after session resolution). */
  onQueryStart?: (session: Session, prompt: string) => void | Promise<void>;
  /** Called at the end of each query (before return). */
  onQueryEnd?: (session: Session, result: QueryResult) => void | Promise<void>;
}

// ----- Agent.create() Config -----

import type { ProviderRegistry } from './registry.js';

/**
 * Simplified config for `Agent.create()`. Three ways to specify provider:
 *
 * 1. **Registry** (recommended for multi-provider): `{ registry, model }`
 * 2. **Full config**: `{ provider: { type, apiKey, model, ... } }`
 * 3. **Shorthand**: `{ providerType, apiKey, model }`
 */
export interface AgentCreateConfig {
  // --- Provider (pick one approach) ---
  /** Use a ProviderRegistry for multi-provider support. */
  registry?: ProviderRegistry;
  /** Full provider config or resolver (alternative to registry/shorthand). */
  provider?: ProviderInput;
  /** Shorthand: provider type (default: 'anthropic'). */
  providerType?: ProviderType;
  /** Shorthand: API key. */
  apiKey?: string;
  /** Shorthand: base URL. */
  baseUrl?: string;
  /** Model name (used with registry or shorthand). */
  model?: string;
  /** Max tokens override. */
  maxTokens?: number;
  /** Thinking budget (Anthropic). */
  thinkingBudget?: number;

  // --- Agent config ---
  /** System prompt (default: generic helpful assistant). */
  systemPrompt?: string | string[];
  /** Tools to register. */
  tools?: ToolRegistration[];
  /** Skill directories. */
  skillDirs?: string[];
  /** Working directory (default: process.cwd()). */
  cwd?: string;
  /** Session store (default: FileSessionStore at `{cwd}/.berry-sessions/`). */
  sessionStore?: SessionStore;
  /** Custom sessions directory (ignored if sessionStore is set). */
  sessionsDir?: string;
  /** Compaction config (defaults applied automatically). */
  compaction?: CompactionConfig;
  /** Tool guard. */
  toolGuard?: ToolGuard;
  /**
   * Event log store. When set, enables append-only event recording.
   * When not set, behavior is identical to the original messages[] approach.
   */
  eventLogStore?: import('./event-log/types.js').EventLogStore;
  /**
   * Agent workspace directory. When set, enables event log, memory, and workspace features.
   * Auto-initializes workspace structure on first use.
   */
  workspace?: string;
  /** Pluggable MemoryProvider — contributes memory tools (search, get, …) to the agent. */
  memory?: import('./memory/provider.js').MemoryProvider;
  /** Project root directory (optional binding for shared project context). */
  project?: string;
  /** Middleware pipeline. */
  middleware?: Middleware[];
  /** Event handler. */
  onEvent?: (event: AgentEvent) => void;
}

// ----- Tool Guard -----

export type ToolGuard = (context: ToolGuardContext) => Promise<ToolGuardDecision>;

export interface ToolGuardContext {
  /** Tool being called */
  toolName: string;
  /** Input arguments */
  input: Record<string, unknown>;
  /** Session info */
  session: { id: string; cwd: string; model: string };
  /** Sequential index of this tool call within the current query */
  callIndex: number;
}

export type ToolGuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'modify'; input: Record<string, unknown> };

export interface CompactionConfig {
  /** Hard threshold to trigger full compaction (default: 85% of context window) */
  threshold?: number;
  /** Soft threshold for lightweight compaction (default: 60% of context window).
   *  When context exceeds softThreshold but is below threshold, only cheap
   *  layers run (clear_thinking, truncate_tool_results, merge_messages).
   *  Set to 0 or same as threshold to disable two-tier behavior. */
  softThreshold?: number;
  /** Context window size (default: 200000) */
  contextWindow?: number;
  /** Which compaction layers to enable for full compaction (default: all) */
  enabledLayers?: CompactionLayer[];
  /** Which layers to run at softThreshold (default: clear_thinking, truncate_tool_results, merge_messages) */
  softLayers?: CompactionLayer[];
}

export type CompactionLayer =
  | 'clear_thinking'
  | 'truncate_tool_results'
  | 'clear_tool_pairs'
  | 'merge_messages'
  | 'summarize'
  | 'trim_assistant'
  | 'truncate_oldest';

// ----- Query Options -----

export interface QueryOptions {
  /** Restrict which tools the agent can use */
  allowedTools?: string[];
  /** Resume a previous session */
  resume?: string;
  /** Fork from a previous session */
  fork?: string;
  /** Override system prompt */
  systemPrompt?: string | string[];
  /** Max tool-calling iterations (default: 25) */
  maxTurns?: number;
  /** Stream model deltas when the provider supports it */
  stream?: boolean;
  /** Per-query event handler */
  onEvent?: (event: AgentEvent) => void;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /**
   * Force JSON schema output. The model will return valid JSON matching this schema.
   * Supported on Anthropic (tool-based extraction) and OpenAI (response_format).
   */
  responseFormat?: JsonSchema;
}

/** JSON Schema for structured output */
export interface JsonSchema {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

// ----- Delegate (one-shot fork) -----

export interface DelegateConfig {
  /** System prompt to append after the main agent's prompt (e.g., skill body) */
  appendSystemPrompt?: string | string[];
  /** Override system prompt entirely (disables cache sharing for system prompt prefix) */
  overrideSystemPrompt?: string | string[];
  /** Whitelist tools by name (from the main agent's registered tools) */
  allowedTools?: string[];
  /** Additional tools only for the delegate */
  additionalTools?: ToolRegistration[];
  /** Override model (WARNING: changes model = breaks prompt cache) */
  model?: string;
  /** Max tool-calling turns */
  maxTurns?: number;
  /** Override the main agent's tool guard */
  toolGuard?: ToolGuard;
  /** Include main conversation history as prefix for cache sharing (default: true) */
  includeHistory?: boolean;
  /** Session ID to use as conversation context (default: last queried session) */
  sessionId?: string;
  /** Stream deltas */
  stream?: boolean;
  /** Per-delegate event handler */
  onEvent?: (event: AgentEvent) => void;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

export interface DelegateResult {
  /** Final text from the delegate */
  text: string;
  /** Token usage accumulated across all turns */
  usage: TokenUsage;
  /** Number of tool-calling turns */
  turns: number;
  /** Number of tool calls */
  toolCalls: number;
}

// ----- Spawn (persistent sub-agent) -----

export interface SpawnConfig {
  /** Custom sub-agent ID */
  id?: string;
  /** System prompt (required for spawn, since sub-agent is independent) */
  systemPrompt: string | string[];
  /** Tools — if not set, inherits all from parent */
  tools?: ToolRegistration[];
  /** Inherit parent's tools in addition to any specified */
  inheritTools?: boolean;
  /** Override model */
  model?: string;
  /** Override tool guard — if not set, inherits parent's */
  toolGuard?: ToolGuard;
  /** Override compaction config */
  compaction?: CompactionConfig;
  /** Max turns per query */
  maxTurns?: number;
  /** Override cwd */
  cwd?: string;
  /** Override session store — if not set, inherits parent's */
  sessionStore?: SessionStore;
}

// ----- Middleware -----

export interface MiddlewareContext {
  sessionId: string;
  model: string;
  provider: string;
  cwd: string;
}

export interface Middleware {
  /** Called before each provider API call. Can modify the request. */
  onBeforeApiCall?: (
    request: ProviderRequest,
    context: MiddlewareContext,
  ) => Promise<ProviderRequest> | ProviderRequest;

  /** Called after each provider API call. Can observe the response. */
  onAfterApiCall?: (
    request: ProviderRequest,
    response: ProviderResponse,
    context: MiddlewareContext,
  ) => Promise<void> | void;

  /** Called before each tool execution. Can modify input or deny. */
  onBeforeToolExec?: (
    toolName: string,
    input: Record<string, unknown>,
    context: MiddlewareContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;

  /** Called after each tool execution. Can observe the result. */
  onAfterToolExec?: (
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    context: MiddlewareContext,
  ) => Promise<void> | void;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  usage: TokenUsage;
  totalUsage: TokenUsage;
  toolCalls: number;
  compacted: boolean;
  /** Error message when query fails (set by try-catch in query()). */
  error?: string;
}

// ----- Session Store -----

export interface SessionStore {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

// ----- Provider Interface -----

export interface Provider {
  readonly type: ProviderType;
  chat(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'response'; response: ProviderResponse };

// ----- Events -----

/**
 * All possible agent event types. Single source of truth.
 * Observe collector, analyzer, and any event consumer should reference these.
 */
export const AGENT_EVENT_TYPES = [
  'query_start', 'api_call', 'text_delta', 'thinking_delta', 'api_response',
  'tool_call', 'tool_result', 'guard_decision', 'compaction', 'memory_flush',
  'query_end', 'delegate_start', 'delegate_end',
  'child_spawned', 'child_destroyed',
  'status_change', 'todo_updated', 'retry',
] as const;

/**
 * Reasons a provider call may be retried under strong-supervision policy.
 * 'stream_idle_timeout' fires when the provider stalled before the first token.
 * 'transient_error' covers retryable HTTP / network errors.
 */
export type RetryReason = 'stream_idle_timeout' | 'transient_error';

// ----- Agent Status -----

/**
 * Fine-grained agent status for UI consumption.
 * Transitions: idle → thinking → (tool_executing | compacting | memory_flushing) → thinking → ... → idle
 */
export type AgentStatus =
  | 'idle'               // Not running a query
  | 'thinking'           // Waiting for LLM response
  | 'tool_executing'     // Executing tool calls
  | 'compacting'         // Running compaction pipeline
  | 'memory_flushing'    // Pre-compact memory flush
  | 'delegating'         // Running a delegate sub-query
  | 'sleeping'           // Suspended by sleep tool; interject() will wake
  | 'error';             // Query failed (transient, returns to idle)

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/**
 * Guard decision event kinds stored in observe DB.
 * Single source of truth for observe collector/analyzer.
 */
export const GUARD_EVENT_KINDS = ['guard_allow', 'guard_deny', 'guard_modify'] as const;
export type GuardEventKind = (typeof GUARD_EVENT_KINDS)[number];

export type AgentEvent =
  | { type: 'query_start'; prompt: string; sessionId: string }
  | { type: 'api_call'; messages: number; tools: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'api_response'; usage: TokenUsage; stopReason: string; model: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'guard_decision'; toolName: string; input: Record<string, unknown>; decision: ToolGuardDecision; callIndex: number; durationMs: number }
  | { type: 'compaction'; layersApplied: CompactionLayer[]; tokensFreed: number;
      triggerReason: 'threshold' | 'soft_threshold' | 'overflow_retry';
      contextBefore: number; contextAfter: number;
      thresholdPct: number; contextWindow: number;
      durationMs: number }
  | { type: 'memory_flush'; reason: 'pre_compact'; charsSaved: number; durationMs: number }
  | { type: 'query_end'; result: QueryResult }
  | { type: 'delegate_start'; message: string }
  | { type: 'delegate_end'; result: DelegateResult }
  | { type: 'child_spawned'; childId: string }
  | { type: 'child_destroyed'; childId: string }
  | { type: 'status_change'; status: AgentStatus; detail?: string }
  | { type: 'todo_updated'; sessionId: string; todos: TodoItem[]; timestamp: number }
  | { type: 'retry'; scope: 'stream' | 'chat'; attempt: number; maxAttempts: number; reason: RetryReason; errorMessage: string; delayMs: number };
