// ============================================================
// Berry Agent SDK — Chat / Timeline Converters
// ============================================================
// UI-friendly chat message formats and converters from raw
// provider messages or append-only session events.

import type {
  Message,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  CompactionLayer,
} from './types.js';
import type {
  SessionEvent,
  CompactionMarkerEvent,
  CompactionTriggerReason,
} from './event-log/types.js';

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  kind?: 'message';
  toolCalls?: ChatToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatCompactionMarker {
  id: string;
  role: 'system';
  kind: 'compaction_marker';
  content: string;
  timestamp?: number;
  compaction: {
    strategy: string;
    triggerReason?: CompactionTriggerReason;
    tokensFreed: number;
    contextBefore?: number;
    contextAfter?: number;
    thresholdPct?: number;
    contextWindow?: number;
    layersApplied?: CompactionLayer[];
    durationMs?: number;
  };
}

export type ChatTimelineItem = ChatMessage | ChatCompactionMarker;

type ToolResultInfo = { content: string; isError?: boolean };
type ChatSourceMessage = Pick<Message, 'role' | 'content' | 'createdAt'>;

/**
 * Convert raw provider messages to UI-friendly chat messages.
 *
 * - Extracts text content from ContentBlock arrays
 * - Pairs tool_use blocks with their tool_result blocks
 * - Generates stable IDs based on message index
 * - Handles both string content and ContentBlock[] content
 */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  const resultMap = buildToolResultMapFromMessages(messages);
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const item = toChatMessage(messages[i], `msg_${i}`, resultMap);
    if (item) result.push(item);
  }

  return result;
}

/**
 * Convert full append-only session events into a UI timeline.
 *
 * Unlike DefaultContextStrategy, this preserves the full event history and
 * inserts compaction markers as explicit system timeline items.
 */
export function toChatTimeline(events: SessionEvent[]): ChatTimelineItem[] {
  const resultMap = buildToolResultMapFromEvents(events);
  const items: ChatTimelineItem[] = [];
  let messageIndex = 0;
  let markerIndex = 0;

  for (const event of events) {
    switch (event.type) {
      case 'user_message': {
        const item = toChatMessage({
          role: 'user',
          content: event.content,
          createdAt: event.timestamp,
        }, `msg_${messageIndex}`, resultMap);
        if (item) {
          items.push(item);
          messageIndex++;
        }
        break;
      }

      case 'assistant_message': {
        const item = toChatMessage({
          role: 'assistant',
          content: event.content,
          createdAt: event.timestamp,
        }, `msg_${messageIndex}`, resultMap);
        if (item) {
          items.push(item);
          messageIndex++;
        }
        break;
      }

      case 'compaction_marker':
        items.push(toCompactionMarkerItem(event, `marker_${markerIndex}`));
        markerIndex++;
        break;

      default:
        break;
    }
  }

  return items;
}

function buildToolResultMapFromMessages(messages: Message[]): Map<string, ToolResultInfo> {
  const resultMap = new Map<string, ToolResultInfo>();
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
  return resultMap;
}

function buildToolResultMapFromEvents(events: SessionEvent[]): Map<string, ToolResultInfo> {
  const resultMap = new Map<string, ToolResultInfo>();
  for (const event of events) {
    if (event.type === 'tool_result') {
      resultMap.set(event.toolUseId, {
        content: event.content,
        isError: event.isError,
      });
    }
  }
  return resultMap;
}

function toChatMessage(
  message: ChatSourceMessage,
  id: string,
  resultMap: Map<string, ToolResultInfo>,
): ChatMessage | null {
  if (typeof message.content === 'string') {
    return {
      id,
      role: message.role,
      content: message.content,
      timestamp: message.createdAt,
    };
  }

  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of message.content) {
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
  if (!content && toolCalls.length === 0 && message.role === 'user') {
    const hasOnlyToolResults = message.content.every(
      (block: ContentBlock) => block.type === 'tool_result',
    );
    if (hasOnlyToolResults) return null;
  }

  return {
    id,
    role: message.role,
    content,
    timestamp: message.createdAt,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function toCompactionMarkerItem(event: CompactionMarkerEvent, id: string): ChatCompactionMarker {
  return {
    id,
    role: 'system',
    kind: 'compaction_marker',
    content: formatCompactionMarkerContent(event),
    timestamp: event.timestamp,
    compaction: {
      strategy: event.strategy,
      triggerReason: event.triggerReason,
      tokensFreed: event.tokensFreed,
      contextBefore: event.contextBefore,
      contextAfter: event.contextAfter,
      thresholdPct: event.thresholdPct,
      contextWindow: event.contextWindow,
      layersApplied: event.layersApplied,
      durationMs: event.durationMs,
    },
  };
}

function formatCompactionMarkerContent(event: CompactionMarkerEvent): string {
  const reason = event.triggerReason ?? normalizeTriggerReason(event.strategy);
  const label = reason === 'soft_threshold'
    ? 'Soft compaction'
    : reason === 'overflow_retry'
      ? 'Overflow recovery compaction'
      : 'Context compaction';

  const details: string[] = [];
  if (typeof event.tokensFreed === 'number') {
    details.push(`freed ~${formatNumber(event.tokensFreed)} tokens`);
  }
  if (typeof event.contextAfter === 'number' && typeof event.contextWindow === 'number') {
    details.push(`${formatNumber(event.contextAfter)}/${formatNumber(event.contextWindow)} tokens after`);
  }

  return details.length > 0
    ? `${label} — ${details.join(' · ')}`
    : label;
}

function normalizeTriggerReason(value: string): CompactionTriggerReason | undefined {
  if (value === 'soft_threshold' || value === 'threshold' || value === 'overflow_retry') {
    return value;
  }
  return undefined;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
