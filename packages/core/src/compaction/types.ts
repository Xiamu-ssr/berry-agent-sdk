// ============================================================
// Berry Agent SDK — Compaction Types
// ============================================================

import type { Message, CompactionConfig, CompactionLayer } from '../types.js';

/**
 * Strategy interface for message compaction.
 * Implement this to provide custom compaction logic.
 */
export interface CompactionStrategy {
  compact(
    messages: Message[],
    config: CompactionConfig,
    options?: { contextWindow?: number },
  ): Promise<CompactionStrategyResult>;
}

export interface CompactionStrategyResult {
  messages: Message[];
  layersApplied: CompactionLayer[];
  tokensFreed: number;
}
