// ============================================================
// Berry Agent SDK — Core Type Definitions
// ============================================================

// ----- Messages (Internal Format) -----
// This is Berry's canonical message format.
// Provider adapters convert to/from wire format.

export type Role = 'user' | 'assistant';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ThinkingContent;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
  /** Whether this message has been compacted */
  compacted?: boolean;
  /** Timestamp */
  createdAt?: number;
}

// ----- Tools -----

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolRegistration {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Content for the LLM (may differ from what user sees) */
  forLLM?: string;
  /** Content for the user (optional, display only) */
  forUser?: string;
}

// ----- Provider -----

export type ProviderType = 'anthropic' | 'openai';

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Anthropic extended thinking budget (0 = disabled) */
  thinkingBudget?: number;
}

export interface ProviderRequest {
  /** System prompt blocks (split for cache optimization) */
  systemPrompt: string[];
  messages: Message[];
  tools?: ToolDefinition[];
  /** Abort signal */
  signal?: AbortSignal;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

// ----- Session -----

export interface Session {
  id: string;
  messages: Message[];
  systemPrompt: string[];
  createdAt: number;
  lastAccessedAt: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  cwd: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  compactionCount: number;
}

// ----- Agent Config -----

export interface AgentConfig {
  provider: ProviderConfig;
  /** Optional injected provider instance (useful for tests/custom providers) */
  providerInstance?: Provider;
  /** System prompt — string or array of blocks (for cache optimization) */
  systemPrompt: string | string[];
  tools?: ToolRegistration[];
  skills?: string[];  // paths to skill .md files
  cwd?: string;
  /** Compaction config */
  compaction?: CompactionConfig;
  /** Session store (default: in-memory) */
  sessionStore?: SessionStore;
  /** Event handler for streaming / logging */
  onEvent?: (event: AgentEvent) => void;
}

export interface CompactionConfig {
  /** Token threshold to trigger compaction (default: 85% of context window) */
  threshold?: number;
  /** Context window size (default: 200000) */
  contextWindow?: number;
  /** Which compaction layers to enable (default: all) */
  enabledLayers?: CompactionLayer[];
}

export type CompactionLayer =
  | 'clear_thinking'
  | 'truncate_tool_results'
  | 'clear_tool_pairs'
  | 'merge_messages'
  | 'summarize'
  | 'trim_assistant'
  | 'truncate_oldest';

// ----- Query Options -----

export interface QueryOptions {
  /** Restrict which tools the agent can use */
  allowedTools?: string[];
  /** Resume a previous session */
  resume?: string;
  /** Fork from a previous session */
  fork?: string;
  /** Override system prompt */
  systemPrompt?: string | string[];
  /** Max tool-calling iterations (default: 25) */
  maxTurns?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  usage: TokenUsage;
  totalUsage: TokenUsage;
  toolCalls: number;
  compacted: boolean;
}

// ----- Session Store -----

export interface SessionStore {
  save(session: Session): Promise<void>;
  load(id: string): Promise<Session | null>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

// ----- Provider Interface -----

export interface Provider {
  readonly type: ProviderType;
  chat(request: ProviderRequest): Promise<ProviderResponse>;
}

// ----- Events -----

export type AgentEvent =
  | { type: 'query_start'; prompt: string; sessionId: string }
  | { type: 'api_call'; messages: number; tools: number }
  | { type: 'api_response'; usage: TokenUsage; stopReason: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'compaction'; layersApplied: CompactionLayer[]; tokensFreed: number }
  | { type: 'query_end'; result: QueryResult };
