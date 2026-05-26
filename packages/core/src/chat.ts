// ============================================================
// Berry Agent SDK - Chat / Session View
// ============================================================
// Public UI-friendly session view assembly. Message/event hydration lives in
// chat-messages.ts; block formatting and timeline wording live in their own
// subdomains so products do not rebuild SDK session history.

import type { Session } from './session-types.js';
import type { SessionEvent } from './event-log/types.js';
import type {
  AgentChatMessage,
  AgentChatTimelineEvent,
  AgentSessionStatus,
  AgentSessionView,
} from './chat-types.js';
import {
  deriveTitleFromEvents,
  deriveTitleFromMessages,
  deriveTitleFromSession,
  toAgentChatMessages,
  toAgentChatMessagesFromEvents,
} from './chat-messages.js';

export { createPendingUserChatMessage } from './chat-messages.js';
export { timelineEventFromAgentEvent } from './chat-timeline.js';

export type {
  AgentChatInference,
  AgentChatMessage,
  AgentChatMessageDelivery,
  AgentChatMessageStatus,
  AgentChatStep,
  AgentChatTimelineEvent,
  AgentChatTimelineItem,
  AgentSessionStatus,
  AgentSessionView,
  ChatToolCall,
} from './chat-types.js';

/**
 * Convert an SDK session plus its append-only event log into the rich chat
 * view expected by host UIs. The event log wins because it preserves the
 * complete pre-compaction timeline; `messages.json` is only the fallback
 * provider-context view.
 */
export function toAgentSessionView(
  session: Session,
  options: { events?: SessionEvent[]; agentId?: string } = {},
): AgentSessionView {
  const eventMessages = options.events && options.events.length > 0
    ? toAgentChatMessagesFromEvents(options.events)
    : [];
  const messages = eventMessages.length > 0
    ? eventMessages
    : toAgentChatMessages(session.messages);
  const eventTimes = options.events?.map((event) => event.timestamp).filter((time) => Number.isFinite(time)) ?? [];
  const status = deriveAgentSessionStatus(options.events);
  if (status === 'interrupted') {
    markInterruptedSession(messages, session.id, eventTimes.at(-1) ?? session.lastAccessedAt);
  }

  return {
    id: session.id,
    title: deriveTitleFromMessages(messages) ?? deriveTitleFromSession(session),
    messages,
    createdAt: eventTimes.length > 0 ? Math.min(...eventTimes) : session.createdAt,
    lastActiveAt: eventTimes.length > 0 ? Math.max(...eventTimes) : session.lastAccessedAt,
    agentId: options.agentId,
    status,
  };
}

/** Lightweight view for session lists. It never expands messages/timeline. */
export function toAgentSessionSummary(
  session: Pick<Session, 'id' | 'createdAt' | 'lastAccessedAt' | 'metadata'>,
  options: { events?: SessionEvent[]; agentId?: string } = {},
): AgentSessionView {
  const eventTimes = options.events?.map((event) => event.timestamp).filter((time) => Number.isFinite(time)) ?? [];
  return {
    id: session.id,
    title: deriveTitleFromEvents(options.events) ?? session.id,
    messages: [],
    createdAt: eventTimes.length > 0 ? Math.min(...eventTimes, session.createdAt) : session.createdAt,
    lastActiveAt: eventTimes.length > 0 ? Math.max(...eventTimes, session.lastAccessedAt) : session.lastAccessedAt,
    agentId: options.agentId,
    status: deriveAgentSessionStatus(options.events),
  };
}

function deriveAgentSessionStatus(events?: SessionEvent[]): AgentSessionStatus {
  if (!events || events.length === 0) return 'idle';
  const ended = new Set<string>();
  const starts: string[] = [];
  for (const event of events) {
    if (event.type === 'query_start' && event.turnId) starts.push(event.turnId);
    if (event.type === 'query_end' && event.turnId) ended.add(event.turnId);
  }
  const latestTurn = starts.at(-1);
  if (!latestTurn) return 'idle';
  return ended.has(latestTurn) ? 'idle' : 'interrupted';
}

function markInterruptedSession(messages: AgentChatMessage[], sessionId: string, timestamp: number): void {
  const event: AgentChatTimelineEvent = {
    id: `interrupted_${sessionId}`,
    kind: 'system',
    title: '上次执行中断',
    detail: 'events.jsonl 中存在未闭合 query_start；实际执行已停止，可直接发送下一条消息。',
    timestamp,
    tone: 'warn',
    collapsed: true,
  };
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (lastAssistant) {
    lastAssistant.status = 'failed';
    lastAssistant.events = [...(lastAssistant.events ?? []), event];
    lastAssistant.timeline = [...(lastAssistant.timeline ?? []), { type: 'event', event }];
    return;
  }
  messages.push({
    id: `interrupted_${sessionId}`,
    role: 'assistant',
    content: '上次执行在完成前中断，已从事件日志标记为停止。',
    timestamp,
    status: 'failed',
    delivery: 'turn',
    events: [event],
    timeline: [{ type: 'event', event }],
  });
}
