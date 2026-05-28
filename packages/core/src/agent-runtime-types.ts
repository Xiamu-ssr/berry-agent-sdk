import type { SystemPromptInput } from '@berry-agent/small-shared-core';
import type { ContentBlock } from './content-types.js';
import type { Session, TodoItem } from './session-types.js';
import type {
  ToolGuard,
  ToolGuardDecision,
  ToolRegistration,
  ToolResult,
} from './tool-types.js';
import type { CompactionLayer } from './compaction/types.js';
import type {
  JsonSchema,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from './provider-types.js';

export interface QueryOptions {
  allowedTools?: string[];
  resume?: string;
  fork?: string;
  systemPrompt?: SystemPromptInput;
  maxTurns?: number;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
  responseFormat?: JsonSchema;
}

/** Create an empty durable session before the first user turn arrives. */
export interface CreateSessionOptions {}

export interface QueryResult {
  text: string;
  sessionId: string;
  usage: TokenUsage;
  totalUsage: TokenUsage;
  toolCalls: number;
  compacted: boolean;
  error?: string;
}

export interface DelegateConfig {
  appendSystemPrompt?: SystemPromptInput;
  overrideSystemPrompt?: SystemPromptInput;
  allowedTools?: string[];
  additionalTools?: ToolRegistration[];
  model?: string;
  maxTurns?: number;
  toolGuard?: ToolGuard;
  includeHistory?: boolean;
  sessionId?: string;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
}

export interface DelegateResult {
  text: string;
  usage: TokenUsage;
  turns: number;
  toolCalls: number;
}

export interface MiddlewareContext {
  sessionId: string;
  model: string;
  provider: string;
  cwd: string;
}

export interface CompactionContext {
  level: 'soft' | 'hard';
  reason: 'threshold' | 'overflow_retry';
  tokensBefore: number;
}

export interface CompactionOutcome {
  tokensFreed: number;
  layersApplied: string[];
  durationMs: number;
}

export interface Middleware {
  onBeforeApiCall?: (
    request: ProviderRequest,
    context: MiddlewareContext,
  ) => Promise<ProviderRequest> | ProviderRequest;
  onAfterApiCall?: (
    request: ProviderRequest,
    response: ProviderResponse,
    context: MiddlewareContext,
  ) => Promise<void> | void;
  onApiCallError?: (
    request: ProviderRequest,
    error: unknown,
    context: MiddlewareContext,
  ) => Promise<void> | void;
  onBeforeToolExec?: (
    toolName: string,
    input: Record<string, unknown>,
    context: MiddlewareContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  onAfterToolExec?: (
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    context: MiddlewareContext,
  ) => Promise<void> | void;
  onBeforeCompact?: (
    compact: CompactionContext,
    context: MiddlewareContext,
  ) => Promise<void> | void;
  onAfterCompact?: (
    compact: CompactionContext,
    outcome: CompactionOutcome,
    context: MiddlewareContext,
  ) => Promise<void> | void;
}

export const AGENT_EVENT_TYPES = [
  'query_start', 'api_call', 'text_delta', 'thinking_delta', 'api_response',
  'tool_call', 'tool_result', 'guard_decision', 'compaction', 'memory_flush',
  'query_end', 'delegate_start', 'delegate_end',
  'status_change', 'todo_updated', 'retry',
  'crash_recovered',
] as const;

export type RetryReason = 'stream_idle_timeout' | 'transient_error';

export type AgentStatus =
  | 'idle'
  | 'tool_use'
  | 'sleeping'
  | 'paused'
  | 'disposed';

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const GUARD_EVENT_KINDS = ['guard_allow', 'guard_deny', 'guard_modify'] as const;
export type GuardEventKind = (typeof GUARD_EVENT_KINDS)[number];

export type AgentEvent =
  | { type: 'query_start'; prompt: string | ContentBlock[]; sessionId: string }
  | { type: 'api_call'; messages: number; tools: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'api_response'; usage: TokenUsage; stopReason: string; model: string }
  | { type: 'tool_call'; name: string; input: unknown; toolUseId?: string }
  | { type: 'tool_result'; name: string; isError: boolean; toolUseId?: string; output?: unknown }
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
  | { type: 'status_change'; status: AgentStatus; detail?: string }
  | { type: 'todo_updated'; sessionId: string; todos: TodoItem[]; timestamp: number }
  | { type: 'retry'; scope: 'stream' | 'chat'; attempt: number; maxAttempts: number; reason: RetryReason; errorMessage: string; delayMs: number }
  | { type: 'crash_recovered'; sessionId: string; artifactCount: number;
      orphanedTools: Array<{ toolUseId: string; name: string; input: Record<string, unknown>; startedAt: number; startEventId: string }>;
      crashedTurnId?: string };
