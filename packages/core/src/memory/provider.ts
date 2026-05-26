/**
 * Memory provider interface — the plugin point for memory backends.
 *
 * Core defines the contract; concrete implementations live in separate
 * packages (e.g. @berry-agent/memory-file, @berry-agent/memory-mem0).
 *
 * Each provider contributes its own capabilities to the agent (memory_search,
 * memory_get, etc.). Core wraps those tool registrations as an SDK-owned
 * memory-provider Hand so they share the same capability boundary as local,
 * MCP, browser, and remote hands.
 */

import type { ToolRegistration } from '../tool-types.js';

export interface MemoryInitContext {
  agentId: string;
  workspaceDir: string;
  dataDir: string;
}

export interface MemoryProvider {
  /** Unique id for debug/log messages. */
  readonly id: string;

  /** Tools this provider contributes to the agent. */
  tools(): ToolRegistration[];

  /**
   * Optional startup hook. Index builds, sqlite opens, embedding warmups.
   * Called once when the agent is constructed; the agent won't run queries
   * until this resolves (if provided).
   */
  init?(ctx: MemoryInitContext): Promise<void>;

  /** Optional teardown hook. May be sync or async. */
  dispose?(): void | Promise<void>;
}
