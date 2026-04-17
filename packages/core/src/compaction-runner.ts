// ============================================================
// Berry Agent SDK — Compaction Runner
// ============================================================
// Extracted from agent.ts: compaction decision-making, memory
// flush, and compaction orchestration.

import type {
  Session,
  CompactionConfig,
  CompactionLayer,
  Provider,
  ToolRegistration,
  AgentEvent,
} from './types.js';
import type { SessionEvent } from './event-log/types.js';
import type { AgentMemory } from './workspace/types.js';
import type { CompactionStrategy } from './compaction/types.js';
import { compact, estimateTokens, type ForkContext, type CompactionResult } from './compaction/compactor.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  DEFAULT_SOFT_COMPACTION_RATIO,
  DEFAULT_SOFT_LAYERS,
} from './constants.js';

/**
 * Determine whether compaction is needed before the next API call.
 *
 * Strategy:
 * - If we have real `inputTokens` from the last API response, use that.
 * - Otherwise, fall back to char-based estimate.
 *
 * Returns:
 * - 'hard' (>=85%): run all enabled layers (including LLM summarize)
 * - 'soft' (>=60%): run only cheap layers
 * - 'none': no compaction needed
 */
export function shouldCompact(params: {
  session: Session;
  compactionConfig?: CompactionConfig;
  contextWindow: number;
}): 'none' | 'soft' | 'hard' {
  const { session, compactionConfig, contextWindow } = params;
  const hardThreshold = compactionConfig?.threshold ?? Math.floor(contextWindow * DEFAULT_COMPACTION_RATIO);
  const softThreshold = compactionConfig?.softThreshold ?? Math.floor(contextWindow * DEFAULT_SOFT_COMPACTION_RATIO);

  let currentTokens: number;
  const lastInput = session.metadata.lastInputTokens;
  if (lastInput !== undefined && lastInput > 0) {
    currentTokens = lastInput;
  } else {
    currentTokens = estimateTokens(session.messages) + estimateTokens_system(session.systemPrompt);
  }

  if (currentTokens > hardThreshold) return 'hard';
  if (currentTokens > softThreshold) return 'soft';
  return 'none';
}

export interface RunCompactionParams {
  session: Session;
  compactionConfig?: CompactionConfig;
  compactLevel: 'soft' | 'hard';
  provider: Provider;
  systemPrompt: string[];
  allowedTools: ToolRegistration[];
  emit: (event: AgentEvent) => void;
  appendEvent: (event: SessionEvent) => Promise<void>;
  makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string };
  /** Custom compaction strategy. If provided, used instead of default 7-layer pipeline. */
  compactionStrategy?: CompactionStrategy;
}

export interface RunCompactionResult {
  compacted: boolean;
  result: CompactionResult;
  durationMs: number;
}

/**
 * Run the compaction pipeline on the session messages.
 */
export async function runCompaction(params: RunCompactionParams): Promise<RunCompactionResult> {
  const {
    session,
    compactionConfig,
    compactLevel,
    provider,
    systemPrompt,
    allowedTools,
    emit,
    appendEvent,
    makeBase,
  } = params;

  const ctxWindow = compactionConfig?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextBefore = session.metadata.lastInputTokens ?? estimateTokens(session.messages);
  const thresholdPct = contextBefore / ctxWindow;
  const layersForLevel = compactLevel === 'soft'
    ? (compactionConfig?.softLayers ?? DEFAULT_SOFT_LAYERS as unknown as CompactionLayer[])
    : (compactionConfig?.enabledLayers);

  // Build fork context for cache-sharing (only needed for hard — summarize uses it)
  const forkCtx: ForkContext = {
    systemPrompt,
    tools: allowedTools.map(t => t.definition),
  };

  const compactStart = Date.now();
  const compactCfg = {
    contextWindow: ctxWindow,
    threshold: compactLevel === 'soft'
      ? (compactionConfig?.softThreshold ?? Math.floor(ctxWindow * DEFAULT_SOFT_COMPACTION_RATIO))
      : compactionConfig?.threshold,
    enabledLayers: layersForLevel,
  };
  const result = params.compactionStrategy
    ? await params.compactionStrategy.compact(session.messages, compactCfg, { contextWindow: ctxWindow })
    : await compact(session.messages, compactCfg, provider, forkCtx);
  const compactDuration = Date.now() - compactStart;
  const contextAfter = estimateTokens(result.messages);
  session.messages = result.messages;
  session.metadata.compactionCount++;

  const triggerReason = compactLevel === 'soft' ? 'soft_threshold' : 'threshold';

  // Event log: compaction_marker
  await appendEvent({
    ...makeBase(),
    type: 'compaction_marker',
    strategy: triggerReason,
    triggerReason,
    tokensFreed: result.tokensFreed,
    contextBefore,
    contextAfter,
    thresholdPct,
    contextWindow: ctxWindow,
    layersApplied: result.layersApplied,
    durationMs: compactDuration,
  });

  emit({
    type: 'compaction',
    layersApplied: result.layersApplied,
    tokensFreed: result.tokensFreed,
    triggerReason,
    contextBefore,
    contextAfter,
    thresholdPct,
    contextWindow: ctxWindow,
    durationMs: compactDuration,
  });

  return { compacted: true, result, durationMs: compactDuration };
}

export interface PreCompactMemoryFlushParams {
  session: Session;
  memory: AgentMemory;
  provider: Provider;
  systemPrompt: string[];
  emit: (event: AgentEvent) => void;
  appendEvent: (event: SessionEvent) => Promise<void>;
  makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string };
}

/**
 * Pre-compact memory flush: save important context to memory before hard compaction.
 */
export async function preCompactMemoryFlush(params: PreCompactMemoryFlushParams): Promise<void> {
  const { session, memory, provider, systemPrompt, emit, appendEvent, makeBase } = params;

  const flushStart = Date.now();
  let charsSaved = 0;
  try {
    const flushResponse = await provider.chat({
      systemPrompt,
      messages: [
        ...session.messages,
        {
          role: 'user' as const,
          content: 'Before context compaction, save important notes, decisions, and context from this conversation to memory. Be concise but capture key information that would be needed in future sessions. Output only the notes to save, nothing else.',
          createdAt: Date.now(),
        },
      ],
      tools: [],
    });
    const notes: string[] = [];
    for (const block of flushResponse.content) {
      if (block.type === 'text') notes.push(block.text);
    }
    const text = notes.join('\n').trim();
    if (text) {
      await memory.append(text);
      charsSaved = text.length;
    }
  } catch {
    // Best-effort: if flush fails, proceed with compaction anyway
  }
  const flushDuration = Date.now() - flushStart;
  await appendEvent({
    ...makeBase(),
    type: 'memory_flush',
    reason: 'pre_compact',
    charsSaved,
  });
  emit({
    type: 'memory_flush',
    reason: 'pre_compact',
    charsSaved,
    durationMs: flushDuration,
  });
}

// ===== Internal Helpers =====

function estimateTokens_system(blocks: string[]): number {
  return blocks.reduce((sum, b) => sum + Math.ceil(b.length / 4), 0);
}
