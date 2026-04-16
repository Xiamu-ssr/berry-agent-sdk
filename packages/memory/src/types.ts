// ============================================================
// Berry Agent SDK — Memory Backend Types
// ============================================================
// Unified interface for memory backends (file, mem0, zep, etc.)
// core defines AgentMemory (load/append/write/exists);
// this package extends with search and structured entries.

import type { AgentMemory } from '@berry-agent/core';

// ----- Memory Entry -----

/** A single memory entry stored in the backend. */
export interface MemoryEntry {
  /** Unique entry ID. */
  id: string;
  /** The memory content (text). */
  content: string;
  /** Arbitrary metadata tags (e.g., { topic: 'architecture', session: 'ses_xxx' }). */
  metadata?: Record<string, unknown>;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Last update timestamp (ms). */
  updatedAt?: number;
  /** Relevance score (populated by search). */
  score?: number;
}

// ----- Search -----

export interface MemorySearchOptions {
  /** Max entries to return (default: 10). */
  limit?: number;
  /** Minimum relevance score (0–1, backend-specific). */
  minScore?: number;
  /** Metadata filter (exact match on each key). */
  filter?: Record<string, unknown>;
}

export interface MemoryListOptions {
  limit?: number;
  offset?: number;
  /** Sort order (default: 'desc' = newest first). */
  order?: 'asc' | 'desc';
}

// ----- Backend Interface -----

/**
 * Searchable memory backend.
 * Extends the basic AgentMemory with structured CRUD + search.
 *
 * Lifecycle:
 *   1. Consumer creates backend: `new FileMemoryBackend(opts)`
 *   2. Pass `backend.asAgentMemory()` to Agent config
 *   3. Agent uses load/append/write internally
 *   4. Consumer (or tools) can use search/add/delete directly
 */
export interface MemoryBackend {
  /** Add a memory entry. Returns entry ID. */
  add(content: string, metadata?: Record<string, unknown>): Promise<string>;

  /** Get a single entry by ID. */
  get(id: string): Promise<MemoryEntry | null>;

  /** Update an existing entry. */
  update(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;

  /** Delete an entry by ID. */
  delete(id: string): Promise<void>;

  /** Semantic or text search over memory entries. */
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;

  /** List entries (paginated). */
  list(options?: MemoryListOptions): Promise<MemoryEntry[]>;

  /** Delete all entries. */
  clear(): Promise<void>;

  /** Entry count. */
  count(): Promise<number>;

  /**
   * Bridge to core's AgentMemory interface.
   * Returns an adapter that can be passed directly to Agent config.
   */
  asAgentMemory(): AgentMemory;
}

// ----- Backend Config -----

export interface FileMemoryConfig {
  /** Directory to store memory files (default: {workspace}/.berry/memory). */
  dir: string;
}

export interface Mem0Config {
  /** mem0 API base URL. */
  baseUrl: string;
  /** mem0 API key. */
  apiKey: string;
  /** User/agent ID for scoping memories. */
  userId?: string;
  agentId?: string;
}

export interface ZepConfig {
  /** Zep server base URL. */
  baseUrl: string;
  /** Zep API key. */
  apiKey: string;
  /** Collection name for memory storage. */
  collection: string;
}
