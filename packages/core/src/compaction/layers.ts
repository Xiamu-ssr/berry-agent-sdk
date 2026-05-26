import type {
  ContentBlock,
  Message,
  ToolResultContent,
  ToolUseContent,
} from '../content-types.js';
import type { Provider } from '../provider-types.js';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import {
  SUMMARIZE_MIN_MESSAGES,
  SUMMARIZE_RECENT_RATIO,
  TOOL_PAIRS_KEEP_RECENT,
  TOOL_RESULT_MAX_LINES,
  TRIM_ASSISTANT_HEAD,
  TRIM_ASSISTANT_TAIL,
  TRIM_ASSISTANT_THRESHOLD,
  TRUNCATE_OLDEST_KEEP_RATIO,
  TRUNCATE_OLDEST_MIN_KEEP,
} from '../constants.js';
import { DEFAULT_PROMPT_PACK, type PromptPack } from '../prompts.js';
import type { CompactionLayer, ForkContext } from './types.js';

export const COMPACTION_LAYER_ORDER: CompactionLayer[] = [
  'clear_thinking',
  'truncate_tool_results',
  'clear_tool_pairs',
  'merge_messages',
  'summarize',
  'trim_assistant',
  'truncate_oldest',
];

export async function applyCompactionLayer(
  layer: CompactionLayer,
  messages: Message[],
  provider: Provider,
  forkContext?: ForkContext,
  promptPack: PromptPack = DEFAULT_PROMPT_PACK,
): Promise<Message[]> {
  switch (layer) {
    case 'clear_thinking': return clearThinkingBlocks(messages);
    case 'truncate_tool_results': return truncateToolResults(messages);
    case 'clear_tool_pairs': return clearOldToolPairs(messages);
    case 'merge_messages': return mergeConsecutiveMessages(messages);
    case 'summarize': return await summarizeOldMessages(messages, provider, forkContext, promptPack);
    case 'trim_assistant': return trimAssistantMessages(messages);
    case 'truncate_oldest': return truncateOldest(messages);
    default: return messages;
  }
}

// Layer 1: keep only the most recent thinking block.
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
      content: msg.content.filter((block) => block.type !== 'thinking'),
      compacted: true,
    };
  });
}

// Layer 2: keep head and tail lines for oversized tool results.
function truncateToolResults(messages: Message[]): Message[] {
  const maxLines = TOOL_RESULT_MAX_LINES;
  const headLines = Math.floor(maxLines / 2);
  const tailLines = maxLines - headLines;

  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let changed = false;
    const newContent = msg.content.map((block) => {
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

// Layer 3: collapse old tool_use/tool_result pairs into plain text summaries.
function clearOldToolPairs(messages: Message[]): Message[] {
  const toolMsgIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!Array.isArray(messages[i].content)) continue;
    const blocks = messages[i].content as ContentBlock[];
    if (blocks.some((block) => block.type === 'tool_use')) {
      toolMsgIndices.push(i);
    }
  }

  if (toolMsgIndices.length <= TOOL_PAIRS_KEEP_RECENT) return messages;

  const oldIndices = new Set(toolMsgIndices.slice(0, -TOOL_PAIRS_KEEP_RECENT));
  const oldResultIndices = new Set<number>();

  for (const idx of oldIndices) {
    if (idx + 1 < messages.length) oldResultIndices.add(idx + 1);
  }

  return messages.map((msg, idx) => {
    if (oldIndices.has(idx)) {
      const blocks = Array.isArray(msg.content) ? msg.content as ContentBlock[] : [];
      const toolNames = blocks
        .filter((block): block is ToolUseContent => block.type === 'tool_use')
        .map((block) => block.name)
        .join(', ');
      return {
        ...msg,
        content: [{ type: 'text' as const, text: `[called: ${toolNames} — result compacted]` }],
        compacted: true,
      };
    }
    if (oldResultIndices.has(idx)) {
      return {
        ...msg,
        content: [{ type: 'text' as const, text: '[tool results compacted]' }],
        compacted: true,
      };
    }
    return msg;
  });
}

// Layer 4: merge adjacent same-role string messages.
function mergeConsecutiveMessages(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const result: Message[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    if (prev.role === curr.role && typeof prev.content === 'string' && typeof curr.content === 'string') {
      result[result.length - 1] = {
        ...prev,
        content: `${prev.content}\n${curr.content}`,
        compacted: true,
      };
    } else {
      result.push(curr);
    }
  }
  return result;
}

async function summarizeOldMessages(
  messages: Message[],
  provider: Provider,
  forkContext?: ForkContext,
  promptPack: PromptPack = DEFAULT_PROMPT_PACK,
): Promise<Message[]> {
  if (messages.length <= SUMMARIZE_MIN_MESSAGES) return messages;

  const recentCount = Math.min(SUMMARIZE_MIN_MESSAGES, Math.floor(messages.length * SUMMARIZE_RECENT_RATIO));
  const oldMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);
  const strippedMessages = stripImagesFromMessages(oldMessages);
  const conversationMessages: Message[] = [
    ...strippedMessages,
    {
      role: 'user' as const,
      content: promptPack.compactSummary
        .replaceAll('{{prompt_pack_version}}', promptPack.version)
        .replaceAll('berry.prompt-pack.v1', promptPack.version),
    },
  ];

  const systemPrompt = normalizeSystemPrompt(
    forkContext?.systemPrompt ?? promptPack.compactSystem,
  );

  try {
    const summaryResponse = await provider.chat({
      systemPrompt,
      messages: conversationMessages,
      ...(forkContext?.tools ? { tools: forkContext.tools } : {}),
    });

    const textBlock = summaryResponse.content.find((block) => block.type === 'text');
    const rawSummary = textBlock ? (textBlock as { type: 'text'; text: string }).text : '';
    if (!rawSummary) return messages;

    const formattedSummary = formatCompactSummary(rawSummary);
    const summaryUserMessage = `${promptPack.handoffResumePrefix}

${formattedSummary}

${promptPack.handoffResumeSuffix}`;

    return [
      {
        role: 'user' as const,
        content: summaryUserMessage,
        compacted: true,
        createdAt: oldMessages[0]?.createdAt,
      },
      ...recentMessages,
    ];
  } catch {
    return messages;
  }
}

function formatCompactSummary(summary: string): string {
  let formatted = summary;
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] || '';
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    );
  }
  formatted = formatted.replace(/\n\n+/g, '\n\n');
  return formatted.trim();
}

function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let hasMedia = false;
    const newContent = msg.content.map((block) => {
      if (block.type === 'thinking') return block;
      if ('source' in block || block.type === 'image') {
        hasMedia = true;
        return { type: 'text' as const, text: '[image]' };
      }
      if ((block as { type: string }).type === 'document') {
        hasMedia = true;
        return { type: 'text' as const, text: '[document]' };
      }
      const trBlock = block as unknown as Record<string, unknown>;
      if (block.type === 'tool_result' && Array.isArray(trBlock.content)) {
        const trContent = trBlock.content as Array<{ type: string }>;
        let toolHasMedia = false;
        const newToolContent = trContent.map((item) => {
          if (item.type === 'image') {
            toolHasMedia = true;
            return { type: 'text' as const, text: '[image]' };
          }
          if (item.type === 'document') {
            toolHasMedia = true;
            return { type: 'text' as const, text: '[document]' };
          }
          return item;
        });
        if (toolHasMedia) {
          hasMedia = true;
          const stripped = newToolContent.map((content) => 'text' in content ? (content as { text: string }).text : '').join('\n');
          return { ...block, content: stripped } as typeof block;
        }
      }
      return block;
    });
    return hasMedia ? { ...msg, content: newContent } : msg;
  });
}

// Layer 6: trim very long string assistant messages.
function trimAssistantMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;
    if (msg.content.length <= TRIM_ASSISTANT_THRESHOLD) return msg;
    return {
      ...msg,
      content: `${msg.content.slice(0, TRIM_ASSISTANT_HEAD)}\n[...trimmed...]\n${msg.content.slice(-TRIM_ASSISTANT_TAIL)}`,
      compacted: true,
    };
  });
}

// Layer 7: leave a synthetic handoff pair and the newest messages.
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

function hasThinkingBlock(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some((block) => block.type === 'thinking');
}
