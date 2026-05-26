// ============================================================
// Berry Agent SDK — Compaction Orchestrator
// ============================================================
// Runs the configured compaction layers as one batch operation so cache
// prefixes stay stable. Individual layer transforms live in layers.ts.

import type { Message } from '../content-types.js';
import type { Provider } from '../provider-types.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
} from '../constants.js';
import { DEFAULT_PROMPT_PACK, type PromptPack } from '../prompts.js';
import type {
  CompactionRuntime,
  CompactionConfig,
  CompactionLayer,
  CompactionStrategy,
  CompactionStrategyResult,
  ForkContext,
} from './types.js';
import {
  applyCompactionLayer,
  COMPACTION_LAYER_ORDER,
} from './layers.js';

export type { CompactionRuntime, ForkContext } from './types.js';

export interface CompactionResult extends CompactionStrategyResult {}

/**
 * Run the full compaction pipeline.
 * Returns a new message array and never mutates the original input.
 *
 * Unit contract:
 * - `config.threshold` and `config.contextWindow` are full-input scale
 *   (system + tools + messages).
 * - `estimateTokens(messages)` is messages-only scale.
 * - `runtime.nonMessageOverhead` bridges those axes so the loop does not stop
 *   early when system prompts and tool definitions are non-trivial.
 */
export async function compact(
  messages: Message[],
  config: CompactionConfig,
  provider: Provider,
  forkContext?: ForkContext,
  promptPack: PromptPack = DEFAULT_PROMPT_PACK,
  runtime?: CompactionRuntime,
): Promise<CompactionResult> {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? Math.floor(contextWindow * DEFAULT_COMPACTION_RATIO);
  const enabledLayers = config.enabledLayers ?? [...COMPACTION_LAYER_ORDER];
  const overhead = Math.max(0, runtime?.nonMessageOverhead ?? 0);
  const layersApplied: CompactionLayer[] = [];

  let current = structuredClone(messages);
  const initialTokens = estimateTokens(current);
  let currentTokens = initialTokens;

  for (const layer of COMPACTION_LAYER_ORDER) {
    if (!enabledLayers.includes(layer)) continue;
    if (currentTokens + overhead <= threshold) break;

    const beforeLen = current.length;
    const before = currentTokens;
    current = await applyCompactionLayer(layer, current, provider, forkContext, promptPack);
    currentTokens = estimateTokens(current);

    // The summarize layer may produce more tokens than terse source messages,
    // but still compact the conversation by reducing message count.
    if (currentTokens < before || current.length !== beforeLen) {
      layersApplied.push(layer);
    }
  }

  return {
    messages: current,
    layersApplied,
    tokensFreed: initialTokens - currentTokens,
  };
}

/**
 * Default compaction strategy wrapping the SDK layer pipeline.
 * Requires a Provider instance for the summarize layer.
 */
export class DefaultCompactionStrategy implements CompactionStrategy {
  constructor(
    private provider: Provider,
    private forkContext?: ForkContext,
  ) {}

  async compact(
    messages: Message[],
    config: CompactionConfig,
    options?: { contextWindow?: number; nonMessageOverhead?: number },
  ): Promise<CompactionStrategyResult> {
    const cfg = options?.contextWindow
      ? { ...config, contextWindow: options.contextWindow }
      : config;
    return compact(
      messages,
      cfg,
      this.provider,
      this.forkContext,
      undefined,
      { nonMessageOverhead: options?.nonMessageOverhead },
    );
  }
}

/**
 * Rough token estimate: ~4 chars per token.
 * Used as a fallback when real API usage data is not available.
 * The Agent prefers real `usage.inputTokens` from the last API response.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as unknown as Record<string, unknown>;
        if (typeof b.text === 'string') {
          total += Math.ceil(b.text.length / 4);
        }
        if (typeof b.content === 'string') {
          total += Math.ceil(b.content.length / 4);
        }
        if (typeof b.thinking === 'string') {
          total += Math.ceil(b.thinking.length / 4);
        }
        if ('input' in b) {
          total += Math.ceil(JSON.stringify(b.input).length / 4);
        }
      }
    }
  }
  return total;
}
