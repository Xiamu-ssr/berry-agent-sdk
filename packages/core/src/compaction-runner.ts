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
  SystemPromptBlock,
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
  COMPACTION_TRIGGER_REASON,
} from './constants.js';

/**
 * Determine the current full-context token count for compaction decisions.
 * Uses the API-returned `lastInputTokens` (ground truth: system+tools+messages)
 * when available, otherwise falls back to char-based estimate.
 */
export function currentContextTokens(params: {
  session: Session;
  systemPrompt: SystemPromptBlock[];
}): number {
  const { session, systemPrompt } = params;
  const lastInput = session.metadata.lastInputTokens;
  if (lastInput !== undefined && lastInput > 0) {
    return lastInput;
  }
  return estimateTokens(session.messages) + estimateTokens_system(systemPrompt);
}

/**
 * Whether soft compaction is needed (>=60% of context window).
 * Soft compaction runs cheap layers only (clear thinking, truncate tool results, merge).
 * Should be checked at **turn entry** — not inside the per-inference loop — to
 * avoid breaking the prompt cache prefix on every iteration.
 */
export function shouldSoftCompact(params: {
  session: Session;
  systemPrompt: SystemPromptBlock[];
  compactionConfig?: CompactionConfig;
  contextWindow: number;
}): boolean {
  const { compactionConfig, contextWindow } = params;
  const softThreshold = compactionConfig?.softThreshold ?? Math.floor(contextWindow * DEFAULT_SOFT_COMPACTION_RATIO);
  return currentContextTokens(params) > softThreshold;
}

/**
 * Whether hard compaction is needed (>=85% of context window).
 * Hard compaction runs all layers including LLM summarize and truncate_oldest.
 * Checked **before every LLM inference** in the agent loop to prevent
 * prompt-too-long errors.
 */
export function shouldHardCompact(params: {
  session: Session;
  systemPrompt: SystemPromptBlock[];
  compactionConfig?: CompactionConfig;
  contextWindow: number;
}): boolean {
  const { compactionConfig, contextWindow } = params;
  const hardThreshold = compactionConfig?.threshold ?? Math.floor(contextWindow * DEFAULT_COMPACTION_RATIO);
  return currentContextTokens(params) > hardThreshold;
}

/**
 * @deprecated Use shouldSoftCompact() or shouldHardCompact() instead.
 * Unified compaction check: returns 'hard' if over hard threshold,
 * 'soft' if over soft threshold, 'none' otherwise.
 */
export function shouldCompact(params: {
  session: Session;
  systemPrompt: SystemPromptBlock[];
  compactionConfig?: CompactionConfig;
  contextWindow: number;
}): 'none' | 'soft' | 'hard' {
  if (shouldHardCompact(params)) return 'hard';
  if (shouldSoftCompact(params)) return 'soft';
  return 'none';
}

export interface RunCompactionParams {
  session: Session;
  compactionConfig?: CompactionConfig;
  compactLevel: 'soft' | 'hard';
  provider: Provider;
  systemPrompt: SystemPromptBlock[];
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
  const messageTokensBefore = estimateTokens(session.messages);
  // contextBefore is the full input tokens (system+tools+messages) from the last API response
  const contextBefore = session.metadata.lastInputTokens ?? messageTokensBefore;
  // Overhead = system_prompt + tools tokens (anything that isn't messages)
  const nonMessageOverhead = Math.max(0, contextBefore - messageTokensBefore);
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
  // contextAfter in full-input terms: system+tools overhead + compressed message tokens
  const messageTokensAfter = estimateTokens(result.messages);
  const contextAfter = nonMessageOverhead + messageTokensAfter;
  session.messages = result.messages;
  session.metadata.compactionCount++;

  // tokensFreed in full-input terms
  const tokensFreed = contextBefore - contextAfter;

  const triggerReason = compactLevel === 'soft'
    ? COMPACTION_TRIGGER_REASON.SOFT_THRESHOLD
    : COMPACTION_TRIGGER_REASON.THRESHOLD;

  // Event log: compaction_marker
  await appendEvent({
    ...makeBase(),
    type: 'compaction_marker',
    strategy: triggerReason,
    triggerReason,
    tokensFreed,
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
    tokensFreed,
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
  systemPrompt: SystemPromptBlock[];
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

function estimateTokens_system(blocks: SystemPromptBlock[]): number {
  return blocks.reduce((sum, block) => sum + Math.ceil(block.text.length / 4), 0);
}
