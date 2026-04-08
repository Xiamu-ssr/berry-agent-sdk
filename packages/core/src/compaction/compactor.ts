// ============================================================
// Agentic SDK — Compaction Pipeline
// ============================================================
// 7-layer compaction pipeline inspired by Claude Code's approach.
// Each layer is applied in order until token count is below threshold.
// KEY DESIGN: batch compaction (not incremental per-request) to preserve cache.

import type { Message, CompactionConfig, CompactionLayer, ContentBlock, Provider } from '../types.js';

export interface CompactionResult {
  messages: Message[];
  layersApplied: CompactionLayer[];
  tokensFreed: number;
}

/**
 * Run the compaction pipeline on a message array.
 * Returns a new message array (does NOT mutate the original).
 * 
 * CRITICAL: All changes happen in ONE batch, not incrementally.
 * This preserves cache prefixes — the opposite of OpenClaw's approach.
 */
export async function compact(
  messages: Message[],
  config: CompactionConfig,
  provider: Provider, // needed for Layer 5 (LLM summarization)
): Promise<CompactionResult> {
  const threshold = config.threshold ?? getDefaultThreshold(config.contextWindow ?? 200_000);
  const enabledLayers = config.enabledLayers ?? ALL_LAYERS;
  const layersApplied: CompactionLayer[] = [];

  let current = structuredClone(messages); // never mutate original
  let initialTokens = estimateTokens(current);
  let currentTokens = initialTokens;

  for (const layer of LAYER_ORDER) {
    if (!enabledLayers.includes(layer)) continue;
    if (currentTokens <= threshold) break; // already under threshold

    const before = currentTokens;
    current = await applyLayer(layer, current, config, provider);
    currentTokens = estimateTokens(current);

    if (currentTokens < before) {
      layersApplied.push(layer);
    }
  }

  return {
    messages: current,
    layersApplied,
    tokensFreed: initialTokens - currentTokens,
  };
}

// ----- Layer Definitions -----

const LAYER_ORDER: CompactionLayer[] = [
  'clear_thinking',
  'truncate_tool_results',
  'clear_tool_pairs',
  'merge_messages',
  'summarize',
  'trim_assistant',
  'truncate_oldest',
];

const ALL_LAYERS: CompactionLayer[] = [...LAYER_ORDER];

async function applyLayer(
  layer: CompactionLayer,
  messages: Message[],
  config: CompactionConfig,
  provider: Provider,
): Promise<Message[]> {
  switch (layer) {
    case 'clear_thinking':
      return clearThinkingBlocks(messages);
    case 'truncate_tool_results':
      return truncateToolResults(messages);
    case 'clear_tool_pairs':
      return clearOldToolPairs(messages);
    case 'merge_messages':
      return mergeConsecutiveMessages(messages);
    case 'summarize':
      return await summarizeOldMessages(messages, provider);
    case 'trim_assistant':
      return trimAssistantMessages(messages);
    case 'truncate_oldest':
      return truncateOldest(messages);
    default:
      return messages;
  }
}

// ----- Layer 1: Clear Thinking Blocks -----
// Thinking blocks are the biggest token consumers.
// Keep only the most recent thinking block.

function clearThinkingBlocks(messages: Message[]): Message[] {
  let lastThinkingIdx = -1;

  // Find the last message with a thinking block
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasThinkingBlock(messages[i])) {
      lastThinkingIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (idx === lastThinkingIdx) return msg; // keep the latest
    if (!hasThinkingBlock(msg)) return msg;
    // Remove thinking blocks from this message
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.filter(b => b.type !== 'thinking'),
        compacted: true,
      };
    }
    return msg;
  });
}

// ----- Layer 2: Truncate Oversized Tool Results -----
// Keep first N and last N lines of large tool results.
// Replace middle with "[...truncated X lines...]"

function truncateToolResults(messages: Message[], maxLines = 50): Message[] {
  const headLines = Math.floor(maxLines / 2);
  const tailLines = maxLines - headLines;

  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const newContent = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;
      const lines = block.content.split('\n');
      if (lines.length <= maxLines) return block;
      const truncated = [
        ...lines.slice(0, headLines),
        `\n[...truncated ${lines.length - maxLines} lines...]\n`,
        ...lines.slice(-tailLines),
      ].join('\n');
      return { ...block, content: truncated };
    });
    return { ...msg, content: newContent, compacted: true };
  });
}

// ----- Layer 3: Clear Old Tool Use/Result Pairs -----
// Keep the N most recent pairs, replace older ones with summary.

function clearOldToolPairs(messages: Message[], keepRecent = 5): Message[] {
  // Find all tool_use indices
  const toolUseIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (Array.isArray(messages[i].content)) {
      const hasToolUse = (messages[i].content as ContentBlock[]).some(b => b.type === 'tool_use');
      if (hasToolUse) toolUseIndices.push(i);
    }
  }

  if (toolUseIndices.length <= keepRecent) return messages;

  // Clear old pairs (keep the last `keepRecent`)
  const oldIndices = new Set(toolUseIndices.slice(0, -keepRecent));
  const oldResultIndices = new Set<number>();

  // Find matching tool_result messages
  for (const idx of oldIndices) {
    if (idx + 1 < messages.length) {
      oldResultIndices.add(idx + 1);
    }
  }

  return messages.map((msg, idx) => {
    if (oldIndices.has(idx)) {
      // Replace tool_use with summary
      return {
        ...msg,
        content: [{ type: 'text' as const, text: '[tool call compacted]' }],
        compacted: true,
      };
    }
    if (oldResultIndices.has(idx)) {
      // Replace tool_result with summary
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: (msg.content as ContentBlock[]).map(b => {
            if (b.type === 'tool_result') {
              return { ...b, content: '[result compacted]' };
            }
            return b;
          }),
          compacted: true,
        };
      }
    }
    return msg;
  });
}

// ----- Layer 4: Merge Consecutive Same-Type Messages -----

function mergeConsecutiveMessages(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const result: Message[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev.role === curr.role && typeof prev.content === 'string' && typeof curr.content === 'string') {
      result[result.length - 1] = {
        ...prev,
        content: prev.content + '\n' + curr.content,
        compacted: true,
      };
    } else {
      result.push(curr);
    }
  }
  return result;
}

// ----- Layer 5: Summarize Old Messages (LLM call) -----

async function summarizeOldMessages(messages: Message[], provider: Provider): Promise<Message[]> {
  if (messages.length <= 10) return messages;

  // Keep recent messages, summarize the rest
  const recentCount = Math.min(10, Math.floor(messages.length * 0.3));
  const oldMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  // Build summary prompt
  const summaryText = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[complex content]'}`)
    .join('\n');

  const summaryResponse = await provider.chat({
    systemPrompt: 'Summarize the following conversation concisely. Preserve key decisions, file paths, and action items.',
    messages: [{
      role: 'user',
      content: `Summarize this conversation:\n\n${summaryText}`,
    }],
  });

  const summaryBlock = summaryResponse.content.find(b => b.type === 'text');
  const summary = summaryBlock ? (summaryBlock as any).text : '[summary unavailable]';

  return [
    {
      role: 'user',
      content: `[Conversation summary]\n${summary}`,
      compacted: true,
      createdAt: oldMessages[0]?.createdAt,
    },
    ...recentMessages,
  ];
}

// ----- Layer 6: Trim Assistant Messages -----

function trimAssistantMessages(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg;
    if (typeof msg.content === 'string' && msg.content.length > 2000) {
      return {
        ...msg,
        content: msg.content.slice(0, 1000) + '\n[...trimmed...]\n' + msg.content.slice(-500),
        compacted: true,
      };
    }
    return msg;
  });
}

// ----- Layer 7: Truncate Oldest Messages -----

function truncateOldest(messages: Message[]): Message[] {
  // Keep at least the last 30% of messages
  const keepCount = Math.max(5, Math.floor(messages.length * 0.3));
  if (messages.length <= keepCount) return messages;
  return [
    {
      role: 'user' as const,
      content: `[${messages.length - keepCount} older messages truncated]`,
      compacted: true,
    },
    ...messages.slice(-keepCount),
  ];
}

// ----- Helpers -----

function hasThinkingBlock(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(b => b.type === 'thinking');
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) total += Math.ceil((block as any).text.length / 4);
        if ('content' in block) total += Math.ceil((block as any).content.length / 4);
        if ('thinking' in block) total += Math.ceil((block as any).thinking.length / 4);
        if ('input' in block) total += Math.ceil(JSON.stringify((block as any).input).length / 4);
      }
    }
  }
  return total;
}

function getDefaultThreshold(contextWindow: number): number {
  return Math.floor(contextWindow * 0.85);
}
