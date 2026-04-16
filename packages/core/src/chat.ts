// ============================================================
// Berry Agent SDK — Chat Message Converter
// ============================================================
// UI-friendly chat message format and converter from raw
// provider messages.

import type { Message, ContentBlock, TextContent, ToolUseContent, ToolResultContent } from './types.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Convert raw provider messages to UI-friendly chat messages.
 *
 * - Extracts text content from ContentBlock arrays
 * - Pairs tool_use blocks with their tool_result blocks
 * - Generates stable IDs based on message index
 * - Handles both string content and ContentBlock[] content
 */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  // Build a map of toolUseId -> tool_result for pairing
  const resultMap = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const tr = block as ToolResultContent;
        resultMap.set(tr.toolUseId, {
          content: tr.content,
          isError: tr.isError,
        });
      }
    }
  }

  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const id = `msg_${i}`;

    if (typeof msg.content === 'string') {
      result.push({
        id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.createdAt,
      });
      continue;
    }

    // ContentBlock[] — extract text and tool calls
    const textParts: string[] = [];
    const toolCalls: ChatMessage['toolCalls'] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_use') {
        const tu = block as ToolUseContent;
        const paired = resultMap.get(tu.id);
        toolCalls.push({
          name: tu.name,
          input: tu.input,
          result: paired?.content,
          isError: paired?.isError,
        });
      } else if (block.type === 'thinking') {
        // Skip thinking blocks in chat view
      }
      // tool_result blocks are consumed via the resultMap pairing
    }

    const content = textParts.join('\n');

    // Skip messages that are purely tool_result containers (user messages with only tool results)
    if (!content && toolCalls.length === 0 && msg.role === 'user') {
      const hasOnlyToolResults = msg.content.every(
        (b: ContentBlock) => b.type === 'tool_result',
      );
      if (hasOnlyToolResults) continue;
    }

    result.push({
      id,
      role: msg.role,
      content,
      timestamp: msg.createdAt,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  return result;
}
