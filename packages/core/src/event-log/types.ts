// ============================================================
// Berry Agent SDK — Session Event Log Types
// ============================================================
// Append-only event log for full session replay.
// The event log is the source of truth; the context window
// (messages[]) is a derived view built by ContextStrategy.

import type { SystemPromptInput } from '@berry-agent/small-shared-core';
import type { DelegateResult, QueryResult } from '../agent-runtime-types.js';
import type { ContentBlock, Message } from '../content-types.js';
import type { ToolGuardDecision } from '../tool-types.js';

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

/** A compact tool invocation event. Prefer ToolUseStartEvent for status-rich logs. */
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

/** Start of a send() call. */
export interface QueryStartEvent extends BaseEvent {
  type: 'query_start';
  prompt: string | ContentBlock[];
}

/** End of a send() call. */
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
  /** Short trigger id; mirrors triggerReason when produced by core. */
  strategy: string;
  /** Structured trigger reason for UI rendering / analytics. */
  triggerReason?: CompactionTriggerReason;
  tokensFreed: number;
  contextBefore?: number;
  contextAfter?: number;
  thresholdPct?: number;
  contextWindow?: number;
  /** SDK compaction layers or custom strategy layer labels. */
  layersApplied?: string[];
  durationMs?: number;
}

/** Guard decision for a tool call. */
export interface GuardDecisionEvent extends BaseEvent {
  type: 'guard_decision';
  toolName: string;
  decision: ToolGuardDecision;
}

/** Human approval was requested for a guarded tool call. */
export interface ApprovalRequestEvent extends BaseEvent {
  type: 'approval_request';
  approvalId: string;
  agentId?: string;
  toolName: string;
  input: Record<string, unknown>;
  callIndex: number;
  reason: string;
  cwd: string;
  model: string;
}

/** Human approval request was answered. */
export interface ApprovalDecisionEvent extends BaseEvent {
  type: 'approval_decision';
  approvalId: string;
  approved: boolean;
  note?: string;
  toolName?: string;
  agentId?: string;
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

/** Provenance summary for the provider context committed by the SDK. */
export interface ContextManifest {
  promptPackVersion: string;
  messageSource: 'messages.json';
  messageCount: number;
  systemBlockCount: number;
  systemBlockHashes: string[];
  toolCount: number;
  toolsHash: string;
}

/** Full API request body sent to the LLM provider. */
export interface ApiRequestEvent extends BaseEvent {
  type: 'api_request';
  requestId: string;
  model: string;
  messages: Message[];
  tools: { name: string; description: string }[];
  params: Record<string, unknown>;
  contextManifest?: ContextManifest;
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

/** Compact API call metadata. Prefer ApiRequestEvent + ApiResponseEvent for full logs. */
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
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
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

/** Draft accepted by SDK APIs that append host/runtime events. */
export type SessionEventDraft = {
  [Event in SessionEvent as Event['type']]: Omit<Event, 'id' | 'timestamp' | 'sessionId'> &
    Partial<Pick<BaseEvent, 'id' | 'timestamp' | 'turnId'>>
}[SessionEvent['type']];

// ----- EventLogStore Interface -----

/** Options for filtering events when reading. */
export interface GetEventsOptions {
  /** Start index (0-based, inclusive) */
  from?: number;
  /** End index (exclusive) */
  to?: number;
  /** Return only the newest N matching events. Implementations should avoid full-file reads when possible. */
  tail?: number;
  /** Maximum bytes to scan for tail reads before returning the matching events found so far. */
  maxBytes?: number;
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
