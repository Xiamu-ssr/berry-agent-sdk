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

// Session stores
export { FileSessionStore } from './session/file-store.js';

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
} from './types.js';
