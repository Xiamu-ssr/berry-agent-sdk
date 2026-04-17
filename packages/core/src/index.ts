// ============================================================
// Berry Agent SDK — Public API
// ============================================================

// Core
export { Agent } from './agent.js';

// Provider Registry
export { ProviderRegistry } from './registry.js';
export type { ProviderEntry, ResolvedModel } from './registry.js';

// Providers
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';

// Compaction
export { compact, estimateTokens, DefaultCompactionStrategy } from './compaction/compactor.js';
export type { ForkContext } from './compaction/compactor.js';
export type { CompactionStrategy, CompactionStrategyResult } from './compaction/types.js';

// Tool Executor
export { executeTools } from './tool-executor.js';
export type { ExecuteToolsParams, ExecuteToolsResult } from './tool-executor.js';

// Compaction Runner
export { shouldCompact, runCompaction, preCompactMemoryFlush } from './compaction-runner.js';

// Chat / Timeline (UI-friendly format)
export { toChatMessages, toChatTimeline } from './chat.js';
export type { ChatMessage, ChatToolCall, ChatCompactionMarker, ChatTimelineItem } from './chat.js';

// Session stores
export { FileSessionStore } from './session/file-store.js';

// Event Log
export { FileEventLogStore, DefaultContextStrategy } from './event-log/index.js';
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
  MetadataEvent,
  MemoryFlushEvent,
  GetEventsOptions,
  EventLogStore,
  ContextStrategy,
} from './event-log/index.js';

// Workspace
export { FileAgentMemory, FileProjectContext, initWorkspace } from './workspace/index.js';
export type { WorkspaceConfig, AgentMemory, ProjectContext, AgentMetadata, MemorySearchProvider, MemorySearchResult } from './workspace/index.js';

// Skills
export { loadSkillsFromDir, loadSkill, buildSkillIndex, getSkillIndexes } from './skills/loader.js';
export type { Skill, SkillMeta, SkillIndex } from './skills/types.js';

// Retry utility (for custom providers)
export { withRetry, isRetryableError, getRetryDelay, classifyError } from './utils/retry.js';
export type { ErrorKind } from './utils/retry.js';

// Credential store (secrets / API keys)
export {
  DefaultCredentialStore,
  MemoryCredentialStore,
  defaultCredentialFilePath,
} from './credentials.js';
export type { CredentialStore } from './credentials.js';

// Constants (for custom configs)
export * from './constants.js';

// Tool name constants (single source of truth)
export * from './tool-names.js';

// Types
export type {
  // Agent config
  AgentConfig,
  QueryOptions,
  QueryResult,
  AgentEvent,
  AgentStatus,

  // Messages
  Message,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  Role,

  // Tools
  ToolDefinition,
  ToolRegistration,
  ToolContext,
  ToolResult,

  // Provider
  Provider,
  ProviderConfig,
  ProviderType,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  TokenUsage,

  // Session
  Session,
  SessionMetadata,
  SessionTodoState,
  SessionStore,
  TodoItem,

  // Compaction
  CompactionConfig,
  CompactionLayer,

  // Tool Guard (permission hook)
  ToolGuard,
  ToolGuardContext,
  ToolGuardDecision,

  // Delegate / Spawn
  DelegateConfig,
  DelegateResult,
  SpawnConfig,

  // Middleware
  Middleware,
  MiddlewareContext,

  // Structured output
  JsonSchema,

  // Multi-modal
  ImageContent,

  // Agent.create() shorthand
  AgentCreateConfig,

  // Event types
  AgentEventType,
  GuardEventKind,
  AGENT_EVENT_TYPES,
  GUARD_EVENT_KINDS,
} from './types.js';
