// ============================================================
// Berry Agent SDK — Compaction Types
// ============================================================

import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import type { Message } from '../content-types.js';
import type { ToolDefinition } from '../tool-types.js';

export type CompactionLayer =
  | 'clear_thinking'
  | 'truncate_tool_results'
  | 'clear_tool_pairs'
  | 'merge_messages'
  | 'summarize'
  | 'trim_assistant'
  | 'truncate_oldest';

export interface CompactionConfig {
  /** Hard threshold to trigger full compaction. */
  threshold?: number;
  /**
   * Soft threshold for lightweight compaction. When context exceeds
   * softThreshold but is below threshold, only cheap layers run.
   */
  softThreshold?: number;
  /** Context window size. */
  contextWindow?: number;
  /** Which compaction layers to enable for full compaction. */
  enabledLayers?: CompactionLayer[];
  /** Which layers to run at softThreshold. */
  softLayers?: CompactionLayer[];
}

/**
 * Strategy interface for message compaction.
 * Implement this to provide custom compaction logic.
 */
export interface CompactionStrategyOptions {
  /** Full-input scale, total tokens the model is allowed to see. */
  contextWindow?: number;
  /**
   * Tokens occupied by everything except messages (system prompt + tools).
   * Lets the strategy compare its messages-only estimate against the
   * full-input threshold without unit drift. See `compactor.ts` for the
   * unit contract.
   */
  nonMessageOverhead?: number;
}

export interface CompactionStrategy {
  compact(
    messages: Message[],
    config: CompactionConfig,
    options?: CompactionStrategyOptions,
  ): Promise<CompactionStrategyResult>;
}

export interface CompactionStrategyResult {
  messages: Message[];
  layersApplied: CompactionLayer[];
  tokensFreed: number;
}

/**
 * Context from the main conversation for cache-sharing during compact.
 * When provided, the summarize layer sends the compact request with the same
 * system prompt + tools + message prefix as the main conversation, so the
 * provider's prompt cache can be reused.
 */
export interface ForkContext {
  systemPrompt: SystemPromptBlock[];
  tools?: ToolDefinition[];
}

/**
 * Runtime context that the caller passes in alongside config.
 * These are live invocation facts, not user-configurable compaction knobs.
 */
export interface CompactionRuntime {
  /**
   * Tokens occupied by everything that is NOT messages (system prompt + tools).
   * This keeps messages-only estimates comparable with full-input thresholds.
   */
  nonMessageOverhead?: number;
}
