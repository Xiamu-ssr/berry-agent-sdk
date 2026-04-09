// ============================================================
// Berry Agent SDK — Compaction Pipeline
// ============================================================
// 7-layer compaction pipeline. Runs as ONE batch operation.
// KEY: all changes happen at once to preserve cache prefixes.

import type { Message, CompactionConfig, CompactionLayer, ContentBlock, Provider, ToolUseContent, ToolResultContent } from '../types.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_RATIO,
  TOOL_RESULT_MAX_LINES,
  TOOL_PAIRS_KEEP_RECENT,
  TRIM_ASSISTANT_THRESHOLD,
  TRIM_ASSISTANT_HEAD,
  TRIM_ASSISTANT_TAIL,
  TRUNCATE_OLDEST_MIN_KEEP,
  TRUNCATE_OLDEST_KEEP_RATIO,
  SUMMARIZE_MIN_MESSAGES,
  SUMMARIZE_RECENT_RATIO,
} from '../constants.js';

export interface CompactionResult {
  messages: Message[];
  layersApplied: CompactionLayer[];
  tokensFreed: number;
}

const LAYER_ORDER: CompactionLayer[] = [
  'clear_thinking',
  'truncate_tool_results',
  'clear_tool_pairs',
  'merge_messages',
  'summarize',
  'trim_assistant',
  'truncate_oldest',
];

/**
 * Run the full compaction pipeline.
 * Returns a new message array (never mutates original).
 * All changes in ONE pass → cache prefix stays stable.
 */
export async function compact(
  messages: Message[],
  config: CompactionConfig,
  provider: Provider,
): Promise<CompactionResult> {
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = config.threshold ?? Math.floor(contextWindow * DEFAULT_COMPACTION_RATIO);
  const enabledLayers = config.enabledLayers ?? [...LAYER_ORDER];
  const layersApplied: CompactionLayer[] = [];

  let current = structuredClone(messages);
  const initialTokens = estimateTokens(current);
  let currentTokens = initialTokens;

  for (const layer of LAYER_ORDER) {
    if (!enabledLayers.includes(layer)) continue;
    if (currentTokens <= threshold) break;

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

async function applyLayer(
  layer: CompactionLayer,
  messages: Message[],
  config: CompactionConfig,
  provider: Provider,
): Promise<Message[]> {
  switch (layer) {
    case 'clear_thinking':      return clearThinkingBlocks(messages);
    case 'truncate_tool_results': return truncateToolResults(messages);
    case 'clear_tool_pairs':    return clearOldToolPairs(messages);
    case 'merge_messages':      return mergeConsecutiveMessages(messages);
    case 'summarize':           return await summarizeOldMessages(messages, provider);
    case 'trim_assistant':      return trimAssistantMessages(messages);
    case 'truncate_oldest':     return truncateOldest(messages);
    default:                    return messages;
  }
}

// ===== Layer 1: Clear Thinking Blocks =====
// Keep only the most recent thinking block.

function clearThinkingBlocks(messages: Message[]): Message[] {
  let lastThinkingIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasThinkingBlock(messages[i])) { lastThinkingIdx = i; break; }
  }

  return messages.map((msg, idx) => {
    if (idx === lastThinkingIdx || !hasThinkingBlock(msg)) return msg;
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.filter(b => b.type !== 'thinking'),
      compacted: true,
    };
  });
}

// ===== Layer 2: Truncate Oversized Tool Results =====
// Keep head + tail lines, replace middle.

function truncateToolResults(messages: Message[]): Message[] {
  const maxLines = TOOL_RESULT_MAX_LINES;
  const headLines = Math.floor(maxLines / 2);
  const tailLines = maxLines - headLines;

  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    let changed = false;
    const newContent = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;
      const tr = block as ToolResultContent;
      const lines = tr.content.split('\n');
      if (lines.length <= maxLines) return block;
      changed = true;
      return {
        ...tr,
        content: [
          ...lines.slice(0, headLines),
          `\n[...truncated ${lines.length - maxLines} lines...]\n`,
          ...lines.slice(-tailLines),
        ].join('\n'),
      };
    });
    return changed ? { ...msg, content: newContent, compacted: true } : msg;
  });
}

// ===== Layer 3: Clear Old Tool Pairs =====
// Keep N most recent tool_use/tool_result pairs, summarize older ones.

function clearOldToolPairs(messages: Message[]): Message[] {
  // Find messages with tool_use content
  const toolMsgIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (Array.isArray(messages[i].content)) {
      const blocks = messages[i].content as ContentBlock[];
      if (blocks.some(b => b.type === 'tool_use')) {
        toolMsgIndices.push(i);
      }
    }
  }

  if (toolMsgIndices.length <= TOOL_PAIRS_KEEP_RECENT) return messages;

  const oldIndices = new Set(toolMsgIndices.slice(0, -TOOL_PAIRS_KEEP_RECENT));
  const oldResultIndices = new Set<number>();

  // Find matching tool_result messages (usually the next message)
  for (const idx of oldIndices) {
    if (idx + 1 < messages.length) oldResultIndices.add(idx + 1);
  }

  return messages.map((msg, idx) => {
    if (oldIndices.has(idx)) {
      // Summarize which tools were called
      const blocks = Array.isArray(msg.content) ? msg.content as ContentBlock[] : [];
      const toolNames = blocks
        .filter((b): b is ToolUseContent => b.type === 'tool_use')
        .map(b => b.name)
        .join(', ');
      return {
        ...msg,
        content: [{ type: 'text' as const, text: `[called: ${toolNames} — result compacted]` }],
        compacted: true,
      };
    }
    if (oldResultIndices.has(idx)) {
      if (!Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: (msg.content as ContentBlock[]).map(b => {
          if (b.type === 'tool_result') {
            return { ...b, content: '[compacted]' } as ToolResultContent;
          }
          return b;
        }),
        compacted: true,
      };
    }
    return msg;
  });
}

// ===== Layer 4: Merge Consecutive Same-Role Messages =====

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

// ===== Layer 5: Summarize Old Messages (LLM call) =====

async function summarizeOldMessages(messages: Message[], provider: Provider): Promise<Message[]> {
  if (messages.length <= SUMMARIZE_MIN_MESSAGES) return messages;

  const recentCount = Math.min(SUMMARIZE_MIN_MESSAGES, Math.floor(messages.length * SUMMARIZE_RECENT_RATIO));
  const oldMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  const summaryText = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[complex content]'}`)
    .join('\n');

  try {
    const summaryResponse = await provider.chat({
      systemPrompt: ['Summarize the conversation concisely. Preserve key decisions, file paths, code changes, and action items.'],
      messages: [{
        role: 'user',
        content: `Summarize this conversation:\n\n${summaryText}`,
      }],
    });

    const textBlock = summaryResponse.content.find(b => b.type === 'text');
    const summary = textBlock ? (textBlock as { type: 'text'; text: string }).text : '[summary failed]';

    return [
      {
        role: 'user' as const,
        content: `[Conversation summary]\n${summary}`,
        compacted: true,
        createdAt: oldMessages[0]?.createdAt,
      },
      {
        role: 'assistant' as const,
        content: 'Understood. I have the context from the summary above.',
        compacted: true,
      },
      ...recentMessages,
    ];
  } catch {
    // If summary fails, fall through to next layers
    return messages;
  }
}

// ===== Layer 6: Trim Long Assistant Messages =====

function trimAssistantMessages(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;
    if (msg.content.length <= TRIM_ASSISTANT_THRESHOLD) return msg;
    return {
      ...msg,
      content: msg.content.slice(0, TRIM_ASSISTANT_HEAD) + '\n[...trimmed...]\n' + msg.content.slice(-TRIM_ASSISTANT_TAIL),
      compacted: true,
    };
  });
}

// ===== Layer 7: Truncate Oldest Messages =====

function truncateOldest(messages: Message[]): Message[] {
  const keepCount = Math.max(TRUNCATE_OLDEST_MIN_KEEP, Math.floor(messages.length * TRUNCATE_OLDEST_KEEP_RATIO));
  if (messages.length <= keepCount) return messages;
  return [
    {
      role: 'user' as const,
      content: `[${messages.length - keepCount} older messages truncated]`,
      compacted: true,
    },
    {
      role: 'assistant' as const,
      content: 'Understood, older context has been removed.',
      compacted: true,
    },
    ...messages.slice(-keepCount),
  ];
}

// ===== Helpers =====

function hasThinkingBlock(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some(b => b.type === 'thinking');
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
        if ('text' in block && typeof (block as any).text === 'string') {
          total += Math.ceil((block as any).text.length / 4);
        }
        if ('content' in block && typeof (block as any).content === 'string') {
          total += Math.ceil((block as any).content.length / 4);
        }
        if ('thinking' in block && typeof (block as any).thinking === 'string') {
          total += Math.ceil((block as any).thinking.length / 4);
        }
        if ('input' in block) {
          total += Math.ceil(JSON.stringify((block as any).input).length / 4);
        }
      }
    }
  }
  return total;
}
