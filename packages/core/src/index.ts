// ============================================================
// Berry Agent SDK — Public API
// ============================================================

// Core
export { Agent } from './agent.js';
export { AgentHome } from './agent-home.js';
export type { AgentHomeSnapshot } from './agent-home.js';
export type { AgentSnapshot, MCPSummary } from './agent-helpers/introspection.js';
export type { CompactionResult } from './compaction/compactor.js';
export { flattenSystemPrompt, normalizeSystemPrompt } from '@berry-agent/small-shared-core';
export { toProviderResolver } from './provider-types.js';
export { providerPublicConfig } from './provider-types.js';
export {
  BUILTIN_PROMPT_PACKS,
  DEFAULT_PROMPT_PACK,
  DEFAULT_PROMPT_PACK_ID,
  builtinPromptPackIds,
  ensurePromptPackDirectory,
  exportPromptPack,
  getBuiltinPromptPack,
  importPromptPack,
  listPromptPacks,
  packsDir,
  promptPackPath,
  readPromptPack,
  readPromptPackFromDirectory,
  resolvePromptPack,
  writePromptPack,
} from './prompts.js';
export type {
  PromptPack,
  PromptPackDescriptor,
  PromptPackDirectoryOptions,
  PromptPackImportOptions,
  PromptPackInput,
} from './prompts.js';

// Providers
export { createProvider } from './agent-helpers/provider.js';

// Compaction
export { compact, estimateTokens, DefaultCompactionStrategy } from './compaction/compactor.js';
export type { ForkContext } from './compaction/compactor.js';
export type { CompactionStrategy, CompactionStrategyResult } from './compaction/types.js';

// Hands / capability boundary
export {
  HandRegistry,
  createHandToolRegistrations,
  createToolRegistrationHand,
} from './hands.js';
export type {
  CreateToolHandOptions,
  Hand,
  HandCall,
  HandCapability,
  HandContext,
  HandKind,
  HandState,
  HandStatus,
  HandToolAdapterOptions,
} from './hands.js';

// Chat / Timeline (UI-friendly format)
export { createPendingUserChatMessage, timelineEventFromAgentEvent, toAgentSessionView } from './chat.js';
export type {
  AgentChatInference,
  AgentChatMessage,
  AgentChatMessageDelivery,
  AgentChatMessageStatus,
  AgentChatStep,
  AgentChatTimelineEvent,
  AgentChatTimelineItem,
  AgentSessionStatus,
  AgentSessionView,
  ChatToolCall,
} from './chat-types.js';

// Managed runtime
export { ManagedAgentRuntime } from './runtime.js';
export type {
  ManagedAgentClearResult,
  ManagedAgentContextSize,
  ManagedAgentDeleteResult,
  ManagedAgentRuntimeCreateOptions,
  ManagedAgentSendOptions,
  ManagedAgentTurnResult,
} from './runtime.js';

// Session stores
export { FileSessionStore } from './session/file-store.js';

// Event Log
export { FileEventLogStore, DefaultContextStrategy, zSessionEvent } from './event-log/index.js';
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
  ApprovalRequestEvent,
  ApprovalDecisionEvent,
  DelegateStartEvent,
  DelegateEndEvent,
  ApiCallEvent,
  MetadataEvent,
  MemoryFlushEvent,
  SessionEventDraft,
  GetEventsOptions,
  EventLogStore,
  ContextStrategy,
} from './event-log/index.js';

// Workspace
export {
  AgentFileBrowser,
  FileAgentMemory,
  FileProjectContext,
  PROJECT_BERRY_DIR,
  PROJECT_CONTEXT_FILE,
  PROJECT_SAFETY_FILE,
  PROJECT_TEAM_FILE,
  PROJECT_TEAM_MESSAGES_FILE,
  PROJECT_WORKLIST_FILE,
  createAgentFileBrowser,
  initWorkspace,
  normalizeBrowsePath,
  projectSharedPaths,
  zAgentMetadata,
  zReasoningEffort,
} from './workspace/index.js';
export type {
  AgentBrowseRoot,
  AgentBrowseRootKind,
  AgentFileBrowserOptions,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  ProjectSharedPaths,
  WorkspaceConfig,
  AgentMemory,
  ProjectContext,
  AgentMetadata,
  ReasoningEffort,
} from './workspace/index.js';
export type { MemoryProvider, MemoryInitContext } from './memory/index.js';

// Skills
export { loadSkillsFromDir, loadSkill, listSkillNamesSync, buildSkillIndex, getSkillIndexes } from './skills/loader.js';
export type { Skill, SkillMeta, SkillIndex, SkillDirSpec } from './skills/types.js';
export type { LoadSkillsOptions } from './skills/loader.js';

// Retry utility (for custom providers)
export { withRetry, isRetryableError, getRetryDelay, classifyError } from './utils/retry.js';
export type { ErrorKind } from './utils/retry.js';

// Command Executor (sandbox abstraction)
export type { CommandExecutor, ExecOptions, ExecResult, SpawnOptions, ProcessHandle } from './executor.js';
export { createCommandEnvironment } from './command-environment.js';
export type { CommandEnvironment, CommandEnvironmentOptions } from './command-environment.js';

// Execution environments (local process / OS sandbox / container / remote)
export {
  ExecutionEnvironmentRegistry,
  createExecutionEnvironment,
  isolationPolicyFromScope,
  workspaceBindingFromScope,
} from './execution-environment.js';
export type {
  CreateExecutionEnvironmentOptions,
  ExecutionEnvironment,
  ExecutionEnvironmentKind,
  ExecutionEnvironmentProvider,
  ExecutionEnvironmentProvisionRequest,
  ExecutionEnvironmentState,
  ExecutionEnvironmentStatus,
  ExecutionIsolationPolicy,
  ExecutionNetworkPolicy,
  ScopeIsolationOptions,
  WorkspaceBinding,
} from './execution-environment.js';

// Agent Scope (permission fact source)
export { AgentScope } from './scope.js';

// Credential store (secrets / API keys)
export {
  DefaultCredentialStore,
  MemoryCredentialStore,
} from './credentials.js';
export type { CredentialStore } from './credentials.js';

// Constants (for custom configs)
export * from './constants.js';

// Tool name constants (single source of truth)
export * from './tool-names.js';

// Tool group enum and labels
export { SystemPromptCacheMode } from '@berry-agent/small-shared-core';
export { ToolGroup, TOOL_GROUP_LABELS } from './tool-types.js';
export { AGENT_EVENT_TYPES, GUARD_EVENT_KINDS } from './agent-runtime-types.js';

// Types
export type {
  AgentConfig,
  AgentCreateConfig,
} from './agent-config-types.js';
export type {
  AgentEvent,
  AgentEventType,
  AgentStatus,
  CreateSessionOptions,
  DelegateConfig,
  DelegateResult,
  GuardEventKind,
  Middleware,
  MiddlewareContext,
  QueryOptions,
  QueryResult,
  RetryReason,
} from './agent-runtime-types.js';
export type {
  AnnotationContent,
  ContentBlock,
  ImageContent,
  Message,
  Role,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
} from './content-types.js';
export type {
  SystemPromptBlock,
  SystemPromptInput,
} from '@berry-agent/small-shared-core';
export type {
  ToolContext,
  ToolDefinition,
  ToolGuard,
  ToolGuardContext,
  ToolGuardDecision,
  ToolRegistration,
  ToolResult,
} from './tool-types.js';
export type {
  JsonSchema,
  ModelRefResolver,
  Provider,
  ProviderConfig,
  ProviderInput,
  ProviderPublicConfig,
  ProviderRequest,
  ProviderResolver,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderType,
  TokenUsage,
} from './provider-types.js';
export type {
  Session,
  SessionMetadata,
  SessionStore,
  SessionTodoState,
  TodoItem,
} from './session-types.js';
export type {
  CompactionConfig,
  CompactionLayer,
} from './compaction/types.js';
