// ============================================================
// Berry Agent SDK — Session Event Log Types
// ============================================================
// Append-only event log for full session replay.
// The event log is the source of truth; the context window
// (messages[]) is a derived view built by ContextStrategy.

import type {
  ContentBlock,
  QueryResult,
  ToolGuardDecision,
  DelegateResult,
  CompactionLayer,
  Message,
  SystemPromptInput,
} from '../types.js';

// ----- Base Event -----

/** Fields shared by every session event. */
export interface BaseEvent {
  /** Unique event ID (nanoid-style) */
  id: string;
  /** Unix timestamp (ms) via Date.now() */
  timestamp: number;
  /** Turn ID grouping events within one query_start..query_end cycle */
  turnId?: string;
  /** Session this event belongs to */
  sessionId: string;
}

// ----- Session Event (discriminated union) -----

/** A user message recorded in the event log. */
export interface UserMessageEvent extends BaseEvent {
  type: 'user_message';
  content: string | ContentBlock[];
}

/** An assistant response recorded in the event log. */
export interface AssistantMessageEvent extends BaseEvent {
  type: 'assistant_message';
  content: ContentBlock[];
}

/** A tool invocation (before execution). 
 *  @deprecated Removed in v1.6. Use ToolUseStartEvent.
 *  Type kept as a narrow alias for log-reading backward compatibility. */
export interface ToolUseEvent extends BaseEvent {
  type: 'tool_use';
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

/** A tool execution result. */
export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

/** Extended thinking content from the model. */
export interface ThinkingEvent extends BaseEvent {
  type: 'thinking';
  thinking: string;
}

/** Start of a query() call. */
export interface QueryStartEvent extends BaseEvent {
  type: 'query_start';
  prompt: string | ContentBlock[];
}

/** End of a query() call. */
export interface QueryEndEvent extends BaseEvent {
  type: 'query_end';
  result: QueryResult;
}

// CompactionTriggerReason is defined in core/constants.ts — single source of truth.
import type { CompactionTriggerReason } from '../constants.js';
export type { CompactionTriggerReason };

/** Marker inserted when compaction occurs. Events before the last marker can be skipped for context building. */
export interface CompactionMarkerEvent extends BaseEvent {
  type: 'compaction_marker';
  /**
   * Legacy field kept for backward compatibility.
   * Mirrors triggerReason when the marker is produced by core.
   */
  strategy: string;
  /** Structured trigger reason for UI rendering / analytics. */
  triggerReason?: CompactionTriggerReason;
  tokensFreed: number;
  contextBefore?: number;
  contextAfter?: number;
  thresholdPct?: number;
  contextWindow?: number;
  layersApplied?: CompactionLayer[];
  durationMs?: number;
}

/** Guard decision for a tool call. */
export interface GuardDecisionEvent extends BaseEvent {
  type: 'guard_decision';
  toolName: string;
  decision: ToolGuardDecision;
}

/** Start of a delegate sub-task. */
export interface DelegateStartEvent extends BaseEvent {
  type: 'delegate_start';
  message: string;
}

/** End of a delegate sub-task. */
export interface DelegateEndEvent extends BaseEvent {
  type: 'delegate_end';
  result: DelegateResult;
}

/** Start of a session — records the complete initial state. */
export interface SessionStartEvent extends BaseEvent {
  type: 'session_start';
  systemPrompt: SystemPromptInput;
  projectContextSnapshot?: string;
  toolsAvailable: string[];
  guardEnabled: boolean;
  providerType: string;
  model: string;
  compactionConfig?: Record<string, unknown>;
}

/** Snapshot of the complete messages[] array after a turn or compaction.
 *  This is the checkpoint for crash recovery — on restart, load the latest
 *  snapshot and replay events after it instead of replaying everything.
 */
export interface MessagesSnapshotEvent extends BaseEvent {
  type: 'messages_snapshot';
  messages: Message[];
  reason: 'turn_end' | 'manual_compact' | 'auto_compact' | 'fork';
}

/** Full API request body sent to the LLM provider. */
export interface ApiRequestEvent extends BaseEvent {
  type: 'api_request';
  requestId: string;
  model: string;
  messages: Message[];
  tools: { name: string; description: string }[];
  params: Record<string, unknown>;
}

/** Full API response received from the LLM provider. */
export interface ApiResponseEvent extends BaseEvent {
  type: 'api_response';
  requestId: string;
  model: string;
  content: ContentBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** Start of a tool call — written before invoking the tool. */
export interface ToolUseStartEvent extends BaseEvent {
  type: 'tool_use_start';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

/** End of a tool call — written after the tool returns. */
export interface ToolUseEndEvent extends BaseEvent {
  type: 'tool_use_end';
  toolUseId: string;
  output: string;
  isError: boolean;
}

/** API call metadata (token usage). 
 *  @deprecated Removed in v1.6. Use ApiRequestEvent + ApiResponseEvent.
 *  Type kept as a narrow alias for log-reading backward compatibility. */
export interface ApiCallEvent extends BaseEvent {
  type: 'api_call';
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Memory flush event — agent saved context to memory before compaction. */
export interface MemoryFlushEvent extends BaseEvent {
  type: 'memory_flush';
  reason: 'pre_compact';
  charsSaved: number;
}

/** Generic metadata extension point. */
export interface MetadataEvent extends BaseEvent {
  type: 'metadata';
  key: string;
  value: unknown;
}

/**
 * Recorded when the SDK detects that a previous run crashed and the current
 * session is being resumed from an event log that contains crash artifacts
 * (e.g. orphaned tool_use_start events). Written at the start of the
 * recovery turn so auditors and observability tooling can correlate the
 * next actions with the crash.
 *
 * This event is the audit-grade counterpart to the automatic interject
 * message that is also queued for the LLM.
 */
export interface CrashRecoveredEvent extends BaseEvent {
  type: 'crash_recovered';
  /** Total number of crash artifacts detected. */
  artifactCount: number;
  /** Orphaned tool calls (tool_use_start without tool_use_end). */
  orphanedTools: Array<{
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    /** Timestamp of the orphaned tool_use_start event. */
    startedAt: number;
    /** Event ID of the orphaned tool_use_start for audit linkage. */
    startEventId: string;
  }>;
  /** True iff a system interject was successfully queued for the next query. */
  interjected: boolean;
  /** Which prior turn (if known) the crash happened in. Optional. */
  crashedTurnId?: string;
}

/**
 * All possible session event types. This is an append-only log:
 * events are never modified or deleted after being written.
 */
export type SessionEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | ThinkingEvent
  | QueryStartEvent
  | QueryEndEvent
  | CompactionMarkerEvent
  | GuardDecisionEvent
  | DelegateStartEvent
  | DelegateEndEvent
  | ApiCallEvent
  | MemoryFlushEvent
  | MetadataEvent
  | SessionStartEvent
  | MessagesSnapshotEvent
  | ApiRequestEvent
  | ApiResponseEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | CrashRecoveredEvent;

/** All session event type discriminators. */
export type SessionEventType = SessionEvent['type'];

// ----- EventLogStore Interface -----

/** Options for filtering events when reading. */
export interface GetEventsOptions {
  /** Start index (0-based, inclusive) */
  from?: number;
  /** End index (exclusive) */
  to?: number;
  /** Only return events with timestamp >= since */
  since?: number;
  /** Only return events matching these types */
  types?: SessionEventType[];
}

/**
 * Append-only event log storage. Events are never modified or deleted
 * (except by explicit `clear` for session reset).
 * Implementations must guarantee ordering: events are returned in append order.
 */
export interface EventLogStore {
  /** Append a single event (never modifies existing events). */
  append(sessionId: string, event: SessionEvent): Promise<void>;

  /** Append multiple events atomically. */
  appendBatch(sessionId: string, events: SessionEvent[]): Promise<void>;

  /** Read events with optional filtering. */
  getEvents(sessionId: string, options?: GetEventsOptions): Promise<SessionEvent[]>;

  /** Get total event count for a session. */
  count(sessionId: string): Promise<number>;

  /** List all session IDs that have event logs. */
  listSessions(): Promise<string[]>;

  /**
   * Clear all events for a session. Used when the user explicitly resets
   * (e.g. "clear chat") — this makes the event log empty so that
   * resolveSession won't rebuild old messages from it.
   */
  clear(sessionId: string): Promise<void>;
}

// ----- Context Strategy Interface -----

/**
 * Strategy for building a provider-ready Message[] from the event log.
 * Different strategies can implement different compaction/filtering logic.
 */
export interface ContextStrategy {
  /** Convert session events into messages suitable for the provider. */
  buildMessages(events: SessionEvent[]): Message[];
}
