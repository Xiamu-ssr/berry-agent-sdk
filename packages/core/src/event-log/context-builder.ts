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
        snapshotMessages = (events[i] as import('./types.js').MessagesSnapshotEvent).messages;
        break;
      }
    }

    // Fallback: no snapshot found — use legacy compaction_marker logic
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
    repairOrphanToolUse(rawMessages);

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

import type { ToolUseContent } from '../types.js';

/**
 * Detect assistant messages that end with tool_use blocks but have no
 * subsequent tool_result. This happens when:
 *   - maxTurns is exhausted mid-tool-loop
 *   - The request is aborted (user closes browser)
 *   - The process crashes between assistant reply and tool execution
 *
 * Without repair, the provider rejects with 400:
 *   "tool_use ids were found without tool_result blocks immediately after"
 *
 * Fix: append a synthetic user message with tool_result(isError=true) for
 * each orphaned tool_use block. The LLM sees the error and can recover.
 */
function repairOrphanToolUse(messages: Message[]): void {
  if (messages.length === 0) return;

  // Collect all tool_use and tool_result IDs globally.
  const allToolUseIds = new Set<string>();
  const allToolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        allToolUseIds.add((block as ToolUseContent).id);
      } else if (block.type === 'tool_result') {
        allToolResultIds.add((block as ToolResultContent).toolUseId);
      }
    }
  }

  // Pass 1: For each assistant message with tool_use, ensure the immediately
  // following user message contains the matching tool_result(s). If a
  // tool_result exists in a later message (e.g. displaced by a crash-recovery
  // interject), move it into the correct position.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter(b => b.type === 'tool_use')
      .map(b => (b as ToolUseContent).id);
    if (toolUseIds.length === 0) continue;

    // Check the next message for tool_results matching these IDs
    const nextMsg = messages[i + 1];
    if (nextMsg && nextMsg.role === 'user' && Array.isArray(nextMsg.content)) {
      const nextResultIds = new Set(
        nextMsg.content
          .filter(b => b.type === 'tool_result')
          .map(b => (b as ToolResultContent).toolUseId),
      );
      const missingIds = toolUseIds.filter(id => !nextResultIds.has(id));
      if (missingIds.length === 0) continue; // all satisfied

      // Some tool_results missing from immediate next message.
      // Find and relocate them from later messages.
      const displacedBlocks: ContentBlock[] = [];
      for (const id of missingIds) {
        if (!allToolResultIds.has(id)) continue; // truly orphaned, handled in pass 2
        for (let j = i + 2; j < messages.length; j++) {
          const laterMsg = messages[j];
          if (laterMsg.role !== 'user' || !Array.isArray(laterMsg.content)) continue;
          const idx = laterMsg.content.findIndex(
            b => b.type === 'tool_result' && (b as ToolResultContent).toolUseId === id,
          );
          if (idx >= 0) {
            displacedBlocks.push(laterMsg.content.splice(idx, 1)[0]!);
            // Remove empty user messages left behind
            if (laterMsg.content.length === 0) {
              messages.splice(j, 1);
            }
            break;
          }
        }
      }

      if (displacedBlocks.length > 0) {
        // Prepend displaced tool_results to the next user message (tool_results first)
        nextMsg.content = [...displacedBlocks, ...nextMsg.content];
      }
    }
  }

  // Pass 2: Handle truly orphaned tool_use (no tool_result anywhere).
  const remainingToolUseIds = new Set<string>();
  const remainingToolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        remainingToolUseIds.add((block as ToolUseContent).id);
      } else if (block.type === 'tool_result') {
        remainingToolResultIds.add((block as ToolResultContent).toolUseId);
      }
    }
  }

  const orphanIds = [...remainingToolUseIds].filter(id => !remainingToolResultIds.has(id));
  if (orphanIds.length === 0) return;

  // Append synthetic tool_result blocks for truly orphaned tool_use
  const syntheticResults: ContentBlock[] = orphanIds.map(id => ({
    type: 'tool_result' as const,
    toolUseId: id,
    content: 'Error: tool execution was interrupted (session ended or aborted). You may retry.',
    isError: true,
  }));

  messages.push({
    role: 'user',
    content: syntheticResults,
    createdAt: Date.now(),
  });
}
