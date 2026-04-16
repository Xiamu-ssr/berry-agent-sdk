// ============================================================
// Berry Agent SDK — Session Event Log Types
// ============================================================
// Append-only event log for full session replay.
// The event log is the source of truth; the context window
// (messages[]) is a derived view built by ContextStrategy.

import type { ContentBlock, QueryResult, ToolGuardDecision, DelegateResult } from '../types.js';

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

/** A tool invocation (before execution). */
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
  prompt: string;
}

/** End of a query() call. */
export interface QueryEndEvent extends BaseEvent {
  type: 'query_end';
  result: QueryResult;
}

/** Marker inserted when compaction occurs. Events before the last marker can be skipped for context building. */
export interface CompactionMarkerEvent extends BaseEvent {
  type: 'compaction_marker';
  strategy: string;
  tokensFreed: number;
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

/** API call metadata (token usage). */
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
  | MetadataEvent;

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
 * Append-only event log storage. Events are never modified or deleted.
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
}

// ----- Context Strategy Interface -----

import type { Message } from '../types.js';

/**
 * Strategy for building a provider-ready Message[] from the event log.
 * Different strategies can implement different compaction/filtering logic.
 */
export interface ContextStrategy {
  /** Convert session events into messages suitable for the provider. */
  buildMessages(events: SessionEvent[]): Message[];
}
