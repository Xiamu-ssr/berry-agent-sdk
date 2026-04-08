// ============================================================
// Berry Agent SDK — Public API
// ============================================================

// Core types
export type {
  // Messages
  Role,
  Message,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,

  // Tools
  ToolDefinition,
  ToolRegistration,
  ToolContext,
  ToolResult,
  ToolParameter,

  // Provider
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  CacheBreakpoint,
  TokenUsage,

  // Session
  Session,
  SessionMetadata,
  SessionStore,

  // Agent
  AgentConfig,
  QueryOptions,
  QueryResult,

  // Compaction
  CompactionConfig,
  CompactionLayer,
} from './types.js';

// Core classes (to be implemented)
// export { Agent } from './agent.js';
// export { AnthropicProvider } from './providers/anthropic.js';
// export { OpenAIProvider } from './providers/openai.js';
// export { Compactor } from './compaction/compactor.js';
// export { CacheManager } from './cache/cache-manager.js';
// export { FileSessionStore } from './session/file-store.js';
