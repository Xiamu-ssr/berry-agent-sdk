// ============================================================
// Berry Agent SDK — Event Log Public API
// ============================================================

export { FileEventLogStore } from './jsonl-store.js';
export { DefaultContextStrategy } from './context-builder.js';
export { detectCrashArtifacts, formatCrashInterject } from './crash-detector.js';
export type { OrphanedToolInfo, CrashDetectionResult } from './crash-detector.js';
export {
  TOOL_CALL_STATUS,
  TOOL_CALL_STATUS_VALUES,
  CRASH_KIND,
  SDK_SYSTEM_WARNING_PREFIX,
} from './constants.js';
export type { ToolCallStatus, CrashKind } from './constants.js';

export type {
  BaseEvent,
  SessionEvent,
  SessionEventType,
  CompactionTriggerReason,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
  ThinkingEvent,
  QueryStartEvent,
  QueryEndEvent,
  CompactionMarkerEvent,
  GuardDecisionEvent,
  DelegateStartEvent,
  DelegateEndEvent,
  ApiCallEvent,
  MemoryFlushEvent,
  MetadataEvent,
  SessionStartEvent,
  MessagesSnapshotEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  ToolUseStartEvent,
  ToolUseEndEvent,
  CrashRecoveredEvent,
  GetEventsOptions,
  EventLogStore,
  ContextStrategy,
} from './types.js';
