// ============================================================
// Berry Agent SDK — Workspace Type Definitions
// ============================================================

/** Agent workspace configuration. */
export interface WorkspaceConfig {
  /** Root directory of agent workspace. */
  root: string;
  /** Initialize workspace if it doesn't exist (default: true). */
  autoInit?: boolean;
}

/** Agent memory interface — per-agent long-term memory. */
export interface AgentMemory {
  /** Load full memory content. Returns empty string if memory file doesn't exist. */
  load(): Promise<string>;
  /** Append content to memory with a timestamp header. */
  append(content: string): Promise<void>;
  /** Replace full memory content. */
  write(content: string): Promise<void>;
  /** Check if memory file exists. */
  exists(): Promise<boolean>;
}

export interface MemorySearchResult {
  /** Optional stable entry ID when backed by a structured memory system. */
  id?: string;
  /** Textual memory content or snippet. */
  content: string;
  /** Backend-specific relevance score. */
  score?: number;
  /** Optional metadata attached by the backend. */
  metadata?: Record<string, unknown>;
  /** Creation timestamp in ms. */
  createdAt?: number;
  /** Last update timestamp in ms. */
  updatedAt?: number;
}

/**
 * Optional search adapter for richer memory backends.
 * This stays separate from AgentMemory so core's file memory and external
 * backends can coexist instead of forcing a single storage strategy.
 */
export interface MemorySearchProvider {
  search(query: string, options?: { limit?: number }): Promise<MemorySearchResult[]>;
}

/** Project context interface — shared knowledge across agents. */
export interface ProjectContext {
  /** Project root directory. */
  readonly root: string;
  /** Load project context files (e.g., AGENTS.md, PROJECT.md). Returns empty string if none found. */
  loadContext(): Promise<string>;
  /** Append a discovery to project knowledge (.berry-discoveries.md). */
  appendDiscovery(content: string): Promise<void>;
}
