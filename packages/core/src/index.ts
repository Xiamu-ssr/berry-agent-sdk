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

// Chat Messages (UI-friendly format)
export { toChatMessages } from './chat.js';
export type { ChatMessage } from './chat.js';

// Session stores
export { FileSessionStore } from './session/file-store.js';

// Event Log
export { FileEventLogStore, DefaultContextStrategy } from './event-log/index.js';
export type {
  BaseEvent,
  SessionEvent,
  SessionEventType,
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
  GetEventsOptions,
  EventLogStore,
  ContextStrategy,
} from './event-log/index.js';

// Workspace
export { FileAgentMemory, FileProjectContext, initWorkspace } from './workspace/index.js';
export type { WorkspaceConfig, AgentMemory, ProjectContext, AgentMetadata } from './workspace/index.js';

// Skills
export { loadSkillsFromDir, loadSkill, buildSkillIndex, getSkillIndexes } from './skills/loader.js';
export type { Skill, SkillMeta, SkillIndex } from './skills/types.js';

// Retry utility (for custom providers)
export { withRetry, isRetryableError, getRetryDelay, classifyError } from './utils/retry.js';
export type { ErrorKind } from './utils/retry.js';

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
  SessionStore,

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

// Re-export MemoryFlushEvent from event log
export type { MemoryFlushEvent } from './event-log/index.js';
