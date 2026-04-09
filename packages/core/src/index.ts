// ============================================================
// Berry Agent SDK — Public API
// ============================================================

// Core
export { Agent } from './agent.js';

// Providers
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';

// Compaction
export { compact, estimateTokens } from './compaction/compactor.js';
export type { ForkContext } from './compaction/compactor.js';

// Session stores
export { FileSessionStore } from './session/file-store.js';

// Skills
export { loadSkillsFromDir, loadSkill, buildSkillIndex, getSkillIndexes } from './skills/loader.js';
export type { Skill, SkillMeta, SkillIndex } from './skills/types.js';

// Retry utility (for custom providers)
export { withRetry, isRetryableError, getRetryDelay } from './utils/retry.js';

// Constants (for custom configs)
export * from './constants.js';

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
} from './types.js';
