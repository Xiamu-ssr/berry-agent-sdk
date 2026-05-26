// ============================================================
// Berry Agent SDK — Context Builder (Event Log → Messages)
// ============================================================
// Converts the append-only event log into a Message[] for recovery tooling.
// Core Agent provider calls do NOT use this as context source:
// messages.json is authoritative, while events.jsonl is audit/UI history.
// The strategy:
//   1. Find the last compaction_marker, start from there
//   2. Convert user_message/assistant_message/tool_use/tool_result → Message format
//   3. Skip non-conversation events (metadata, api_call, query_start, query_end, etc.)
//   4. Merge adjacent same-role messages

import type { Message, ContentBlock, ToolResultContent } from '../content-types.js';
import { repairOrphanToolUses } from '../message-repair.js';
import type { ContextStrategy, MessagesSnapshotEvent, SessionEvent } from './types.js';

/**
 * Event types that map directly to conversation messages.
 * NOTE: 'tool_use' is excluded because tool_use blocks are already embedded
 * inside assistant_message.content (as ContentBlock[]). Including separate
 * tool_use events would duplicate tool_use ids, causing provider errors.
 */
const CONVERSATION_EVENT_TYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_result',
]);

/**
 * Events that can be appended to an existing messages[] baseline.
 * After a messages_snapshot, only these events produce new messages.
 */
const REPLAY_EVENT_TYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_result',
]);

/**
 * Default context strategy: replays conversation events from the event log,
 * skipping everything before the last compaction_marker.
 */
export class DefaultContextStrategy implements ContextStrategy {
  /** Convert session events into messages suitable for the provider. */
  buildMessages(events: SessionEvent[]): Message[] {
    // DURABILITY: find the most recent messages_snapshot — this is our
    // checkpoint. All events before it can be skipped; we start from the
    // snapshot's messages[] and replay only events after it.
    let snapshotIndex = -1;
    let snapshotMessages: Message[] | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'messages_snapshot') {
        snapshotIndex = i;
        snapshotMessages = (events[i] as MessagesSnapshotEvent).messages;
        break;
      }
    }

    // Fallback: no snapshot found — start after the latest compaction marker.
    let startIndex = 0;
    if (snapshotIndex < 0) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'compaction_marker') {
          startIndex = i + 1;
          break;
        }
      }
    } else {
      startIndex = snapshotIndex + 1;
    }

    // 2. Filter to replayable conversation events after the snapshot/marker
    const replayEvents = events
      .slice(startIndex)
      .filter(e => REPLAY_EVENT_TYPES.has(e.type));

    // 3. Start from snapshot messages (if any) or empty
    const rawMessages: Message[] = snapshotMessages
      ? snapshotMessages.map(m => ({ ...m })) // shallow clone
      : [];

    for (const event of replayEvents) {
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

        case 'tool_result': {
          const resultBlock: ToolResultContent = {
            type: 'tool_result',
            toolUseId: event.toolUseId,
            content: event.content,
            isError: event.isError || undefined,
          };
          const lastMsg = rawMessages[rawMessages.length - 1];
          if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
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

    // 4. Repair orphan tool_use blocks.
    repairOrphanToolUses(rawMessages);

    // 5. Merge adjacent same-role messages
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
