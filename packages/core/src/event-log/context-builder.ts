// ============================================================
// Berry Agent SDK — Context Builder (Event Log → Messages)
// ============================================================
// Converts the append-only event log into a provider-ready Message[].
// The default strategy:
//   1. Find the last compaction_marker, start from there
//   2. Convert user_message/assistant_message/tool_use/tool_result → Message format
//   3. Skip non-conversation events (metadata, api_call, query_start, query_end, etc.)
//   4. Merge adjacent same-role messages

import type { Message, ContentBlock, ToolResultContent } from '../types.js';
import type { ContextStrategy, SessionEvent } from './types.js';

/** Event types that map directly to conversation messages. */
const CONVERSATION_EVENT_TYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_use',
  'tool_result',
]);

/**
 * Default context strategy: replays conversation events from the event log,
 * skipping everything before the last compaction_marker.
 */
export class DefaultContextStrategy implements ContextStrategy {
  /** Convert session events into messages suitable for the provider. */
  buildMessages(events: SessionEvent[]): Message[] {
    // 1. Find last compaction_marker
    let startIndex = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'compaction_marker') {
        startIndex = i + 1;
        break;
      }
    }

    // 2. Filter to conversation events only
    const conversationEvents = events
      .slice(startIndex)
      .filter(e => CONVERSATION_EVENT_TYPES.has(e.type));

    // 3. Convert events to messages
    const rawMessages: Message[] = [];

    for (const event of conversationEvents) {
      switch (event.type) {
        case 'user_message':
          rawMessages.push({
            role: 'user',
            content: event.content,
            createdAt: event.timestamp,
          });
          break;

        case 'assistant_message':
          rawMessages.push({
            role: 'assistant',
            content: event.content,
            createdAt: event.timestamp,
          });
          break;

        case 'tool_use': {
          // tool_use is part of the assistant's response, append to last assistant message
          const block: ContentBlock = {
            type: 'tool_use',
            id: event.toolUseId,
            name: event.name,
            input: event.input,
          };
          const lastMsg = rawMessages[rawMessages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.content)) {
            lastMsg.content.push(block);
          } else {
            rawMessages.push({
              role: 'assistant',
              content: [block],
              createdAt: event.timestamp,
            });
          }
          break;
        }

        case 'tool_result': {
          // tool_result is a user message containing tool_result blocks
          const resultBlock: ToolResultContent = {
            type: 'tool_result',
            toolUseId: event.toolUseId,
            content: event.content,
            isError: event.isError || undefined,
          };
          const lastMsg = rawMessages[rawMessages.length - 1];
          if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
            // Check if it's already a tool_result message (same batch)
            const blocks = lastMsg.content as ContentBlock[];
            if (blocks.length > 0 && blocks[0].type === 'tool_result') {
              blocks.push(resultBlock);
            } else {
              rawMessages.push({
                role: 'user',
                content: [resultBlock],
                createdAt: event.timestamp,
              });
            }
          } else {
            rawMessages.push({
              role: 'user',
              content: [resultBlock],
              createdAt: event.timestamp,
            });
          }
          break;
        }
      }
    }

    // 4. Merge adjacent same-role messages
    return mergeAdjacentMessages(rawMessages);
  }
}

/**
 * Merge adjacent messages with the same role into a single message.
 * Content is concatenated (string + string, or arrays merged).
 */
function mergeAdjacentMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return [];

  const merged: Message[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge content
      prev.content = mergeContent(prev.content, curr.content);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/** Merge two content values (string | ContentBlock[]) into one. */
function mergeContent(
  a: string | ContentBlock[],
  b: string | ContentBlock[],
): string | ContentBlock[] {
  const blocksA = typeof a === 'string' ? [{ type: 'text' as const, text: a }] : a;
  const blocksB = typeof b === 'string' ? [{ type: 'text' as const, text: b }] : b;
  return [...blocksA, ...blocksB];
}
