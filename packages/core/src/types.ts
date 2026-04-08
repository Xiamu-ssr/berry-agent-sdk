// ============================================================
// Agentic SDK — Core Type Definitions
// ============================================================

// ----- Messages -----

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
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
  /** Original token count before any compaction */
  originalTokens?: number;
  /** Whether this message has been compacted */
  compacted?: boolean;
  /** Timestamp */
  createdAt?: number;
}

// ----- Tools -----

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
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

export interface ProviderConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
}

export interface ProviderRequest {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  /** Anthropic-specific: where to place cache breakpoints */
  cacheBreakpoints?: CacheBreakpoint[];
}

export interface CacheBreakpoint {
  /** Which part of the request to mark */
  target: 'system' | 'tools' | 'message';
  /** Index (for messages) */
  index?: number;
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
  systemPrompt: string;
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
  provider: ProviderConfig & { type: 'anthropic' | 'openai' };
  systemPrompt: string;
  tools?: ToolRegistration[];
  skills?: string[];  // paths to skill .md files
  cwd?: string;
  /** Compaction config */
  compaction?: CompactionConfig;
  /** Session store (default: in-memory) */
  sessionStore?: SessionStore;
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
  | 'clear_thinking'       // Layer 1: Clear old thinking blocks
  | 'truncate_tool_results' // Layer 2: Truncate oversized tool results
  | 'clear_tool_pairs'     // Layer 3: Clear old tool_use/tool_result pairs
  | 'merge_messages'       // Layer 4: Merge consecutive same-type messages
  | 'summarize'            // Layer 5: LLM-generated summary
  | 'trim_assistant'       // Layer 6: Remove redundant assistant parts
  | 'truncate_oldest';     // Layer 7: Last resort — drop oldest messages

// ----- Query Options -----

export interface QueryOptions {
  /** Restrict which tools the agent can use for this query */
  allowedTools?: string[];
  /** Resume a previous session */
  resume?: string;
  /** Fork from a previous session */
  fork?: string;
  /** Override system prompt for this query */
  systemPrompt?: string;
  /** Max tool-calling iterations (default: 25) */
  maxTurns?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

export interface QueryResult {
  /** Final text response */
  text: string;
  /** Session ID (for resume/fork) */
  sessionId: string;
  /** Token usage for this query */
  usage: TokenUsage;
  /** Total usage across the session */
  totalUsage: TokenUsage;
  /** Number of tool calls made */
  toolCalls: number;
  /** Whether compaction occurred during this query */
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
  readonly type: 'anthropic' | 'openai';
  chat(request: ProviderRequest): Promise<ProviderResponse>;
}
