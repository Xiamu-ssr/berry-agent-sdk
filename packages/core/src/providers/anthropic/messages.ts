import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlockParam,
  ContentBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Message,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  ImageContent,
  AnnotationContent,
} from '../../content-types.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { ProviderRequest } from '../../provider-types.js';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';

export const ANTHROPIC_EMPTY_MESSAGE_TEXT = '(empty message)';
export const ANTHROPIC_EMPTY_ASSISTANT_TEXT = '(empty assistant message)';
export const ANTHROPIC_UNSIGNED_THINKING_OMITTED_TEXT = '(unsigned thinking omitted)';
export const ANTHROPIC_EMPTY_TOOL_RESULT_TEXT = '(empty tool result)';

/**
 * Build cache-aware Anthropic system text blocks.
 * Empty system prompt blocks are omitted because Anthropic rejects empty text blocks.
 */
export function buildAnthropicSystemBlocks(systemPrompt: ProviderRequest['systemPrompt']): TextBlockParam[] {
  const blocks = normalizeSystemPrompt(systemPrompt).filter(block => block.text.trim());
  let lastStableIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.cache !== 'dynamic') {
      lastStableIndex = i;
      break;
    }
  }

  const cacheBreakpointIndexes = new Set<number>();
  if (lastStableIndex >= 0) cacheBreakpointIndexes.add(lastStableIndex);
  if (blocks.length > 0) cacheBreakpointIndexes.add(blocks.length - 1);

  return blocks.map((block, idx) => ({
    type: 'text' as const,
    text: block.text,
    ...(cacheBreakpointIndexes.has(idx)
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }));
}

/**
 * Convert Berry's canonical session messages into Anthropic wire messages.
 * This is also the final Anthropic boundary sanitizer: no returned text block
 * is empty, and any message that would become empty receives a non-empty
 * placeholder so legacy/cross-provider sessions cannot poison Claude calls.
 */
export function buildAnthropicMessages(
  messages: Message[],
  cacheBudget: number,
): MessageParam[] {
  const result: MessageParam[] = [];
  const cacheStartIndex = Math.max(messages.length - cacheBudget, 0);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isRecentTurn = cacheBudget > 0 && i >= cacheStartIndex;

    if (msg.role === 'user') {
      result.push(buildAnthropicUserMessage(msg, isRecentTurn));
    } else if (msg.role === 'assistant') {
      result.push(buildAnthropicAssistantMessage(msg, isRecentTurn));
    }
  }

  return sanitizeAnthropicMessages(result);
}

export function buildAnthropicUserMessage(msg: Message, addCache: boolean): MessageParam {
  if (typeof msg.content === 'string') {
    const text = normalizeNonEmptyText(msg.content, ANTHROPIC_EMPTY_MESSAGE_TEXT);
    const block: TextBlockParam = {
      type: 'text',
      text,
      ...(addCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
    return { role: 'user', content: [block] };
  }

  // Anthropic requires tool_result blocks to come FIRST in the user message,
  // with text / image blocks AFTER all tool_results.
  const toolResults: ContentBlockParam[] = [];
  const otherBlocks: ContentBlockParam[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      const tr = block as ToolResultContent;
      toolResults.push({
        type: 'tool_result' as const,
        tool_use_id: tr.toolUseId,
        content: normalizeNonEmptyText(tr.content, ANTHROPIC_EMPTY_TOOL_RESULT_TEXT),
        is_error: tr.isError ?? false,
      } as ToolResultBlockParam);
    } else if (block.type === 'text') {
      const text = block.text.trim();
      if (text) {
        otherBlocks.push({ type: 'text' as const, text: block.text });
      }
    } else if (block.type === 'image') {
      const img = block as ImageContent;
      otherBlocks.push({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: img.mediaType,
          data: img.data,
        },
      } as unknown as ContentBlockParam);
    } else if (block.type === 'annotation') {
      const annotation = block as AnnotationContent;
      otherBlocks.push({
        type: 'text' as const,
        text: formatAnnotationForModel(annotation),
      });
      otherBlocks.push({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: annotation.image.mediaType,
          data: annotation.image.data,
        },
      } as unknown as ContentBlockParam);
    } else {
      const fallback = stringifyUnknownBlock(block);
      if (fallback) otherBlocks.push({ type: 'text' as const, text: fallback });
    }
  }

  const content: ContentBlockParam[] = [...toolResults, ...otherBlocks];
  if (content.length === 0) {
    content.push({ type: 'text' as const, text: ANTHROPIC_EMPTY_MESSAGE_TEXT });
  }

  addCacheToLastBlock(content, addCache);
  return { role: 'user', content };
}

export function buildAnthropicAssistantMessage(msg: Message, addCache: boolean): MessageParam {
  if (typeof msg.content === 'string') {
    const text = normalizeNonEmptyText(msg.content, ANTHROPIC_EMPTY_ASSISTANT_TEXT);
    const block: TextBlockParam = {
      type: 'text',
      text,
      ...(addCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
    return { role: 'assistant', content: [block] };
  }

  const content: ContentBlockParam[] = [];
  let omittedUnsignedThinking = false;

  for (let idx = 0; idx < msg.content.length; idx++) {
    const block = msg.content[idx]!;
    const isLast = idx === msg.content.length - 1;
    const cache = addCache && isLast
      ? { cache_control: { type: 'ephemeral' as const } }
      : {};

    if (block.type === 'text') {
      if (!block.text.trim()) continue;
      content.push({ type: 'text' as const, text: block.text, ...cache });
    } else if (block.type === 'tool_use') {
      const tu = block as ToolUseContent;
      content.push({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.name,
        input: tu.input,
        ...cache,
      } as ToolUseBlockParam);
    } else if (block.type === 'thinking') {
      const t = block as ThinkingContent;
      // Anthropic thinking is provider-private proof-carrying data. Only
      // replay signed, non-empty Anthropic thinking blocks; OpenAI/Gemini/Kimi
      // reasoning_content must not be sent to Claude as unsigned thinking.
      if (!t.signature || !t.thinking.trim()) {
        omittedUnsignedThinking = true;
        continue;
      }
      content.push({
        type: 'thinking' as const,
        thinking: t.thinking,
        signature: t.signature,
        ...cache,
      } as unknown as ContentBlockParam);
    } else {
      const fallback = stringifyUnknownBlock(block);
      if (fallback) content.push({ type: 'text' as const, text: fallback, ...cache });
    }
  }

  if (content.length === 0) {
    content.push({
      type: 'text' as const,
      text: omittedUnsignedThinking
        ? ANTHROPIC_UNSIGNED_THINKING_OMITTED_TEXT
        : ANTHROPIC_EMPTY_ASSISTANT_TEXT,
    });
  } else {
    ensureCacheOnLastBlock(content, addCache);
  }

  return { role: 'assistant', content };
}

export function buildAnthropicTools(
  tools: ToolDefinition[],
  responseFormat?: ProviderRequest['responseFormat'],
): Anthropic.Tool[] {
  const mapped = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));

  if (responseFormat) {
    mapped.push({
      name: responseFormat.name,
      description: responseFormat.description ?? `Return structured JSON output matching the ${responseFormat.name} schema.`,
      input_schema: responseFormat.schema as Anthropic.Tool.InputSchema,
    });
  }

  return mapped;
}

export function sanitizeAnthropicMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map(message => {
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text' as const, text: String(message.content ?? '') }];

    const cleaned: ContentBlockParam[] = [];
    for (const block of content) {
      const clean = sanitizeAnthropicContentBlock(block);
      if (clean) cleaned.push(clean);
    }

    return {
      role: message.role,
      content: cleaned.length > 0
        ? cleaned
        : [{ type: 'text' as const, text: message.role === 'assistant' ? ANTHROPIC_EMPTY_ASSISTANT_TEXT : ANTHROPIC_EMPTY_MESSAGE_TEXT }],
    } as MessageParam;
  });
}

function sanitizeAnthropicContentBlock(block: ContentBlockParam): ContentBlockParam | null {
  if (block.type === 'text') {
    const text = (block as TextBlockParam).text;
    if (!text || !text.trim()) return null;
    return block;
  }

  if (block.type === 'tool_result') {
    const tr = block as ToolResultBlockParam;
    const content = typeof tr.content === 'string'
      ? normalizeNonEmptyText(tr.content, ANTHROPIC_EMPTY_TOOL_RESULT_TEXT)
      : tr.content;
    return { ...tr, content } as ToolResultBlockParam;
  }

  if (block.type === 'thinking') {
    const t = block as unknown as { thinking?: string; signature?: string };
    if (!t.signature || !t.thinking?.trim()) return null;
    return block;
  }

  return block;
}

function normalizeNonEmptyText(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

function stringifyUnknownBlock(block: ContentBlock): string | null {
  const text = JSON.stringify(block);
  return text && text.trim() ? text : null;
}

function formatAnnotationForModel(block: AnnotationContent): string {
  const sourceTitle = block.source.title ? ` (${block.source.title})` : '';
  return [
    'Human browser annotation:',
    block.body,
    `Source: ${block.source.url}${sourceTitle}`,
    `Selected region: x=${Math.round(block.rect.x)}, y=${Math.round(block.rect.y)}, width=${Math.round(block.rect.width)}, height=${Math.round(block.rect.height)} of viewport ${Math.round(block.viewport.width)}x${Math.round(block.viewport.height)}.`,
    'The following image is the cropped highlighted region.',
  ].join('\n');
}

function addCacheToLastBlock(content: ContentBlockParam[], addCache: boolean): void {
  if (!addCache || content.length === 0) return;
  const last = content[content.length - 1]!;
  (last as ContentBlockParam & { cache_control?: unknown }).cache_control = { type: 'ephemeral' as const };
}

function ensureCacheOnLastBlock(content: ContentBlockParam[], addCache: boolean): void {
  if (!addCache || content.length === 0) return;
  const hasCache = content.some(block => 'cache_control' in block && block.cache_control);
  if (!hasCache) addCacheToLastBlock(content, true);
}
