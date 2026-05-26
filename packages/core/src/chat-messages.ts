import type {
  AnnotationContent,
  ContentBlock,
  ToolResultContent,
  ToolUseContent,
} from './content-types.js';
import type { Session } from './session-types.js';
import type { SessionEvent } from './event-log/types.js';
import type {
  AgentChatInference,
  AgentChatMessage,
  AgentChatStep,
  AgentChatTimelineEvent,
  AgentChatTimelineItem,
  ChatToolCall,
} from './chat-types.js';
import {
  previewTextForBlock,
  stablePromptSuffix,
  textFromBlocks,
  thinkingFromBlocks,
} from './chat-blocks.js';
import { agentTimelineEventFromSessionEvent } from './chat-timeline.js';

/** Build a transient user bubble for streaming UIs before the provider returns. */
export function createPendingUserChatMessage(
  prompt: string | ContentBlock[],
  options: { requestId?: string; timestamp?: number } = {},
): AgentChatMessage {
  const timestamp = options.timestamp ?? Date.now();
  const isBlocks = typeof prompt !== 'string';
  const textPreview = isBlocks
    ? prompt.map(previewTextForBlock).join(' ').trim()
    : prompt;
  const blocks = isBlocks
    ? prompt.filter((block): block is { type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string } | AnnotationContent =>
        block.type === 'text' || block.type === 'image' || block.type === 'annotation',
      )
    : undefined;

  return {
    id: `pending_${timestamp}_${stablePromptSuffix(prompt)}`,
    role: 'user',
    content: textPreview || '(media)',
    timestamp,
    status: 'pending',
    delivery: 'turn',
    requestId: options.requestId,
    blocks,
  };
}

export function toAgentChatMessages(messages: Session['messages']): AgentChatMessage[] {
  const out: AgentChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'user') {
      const user = agentUserMessageFromContent(msg.content, `msg_${msg.createdAt ?? i}_${i}`, msg.createdAt ?? Date.now());
      if (user) out.push(user);
      continue;
    }

    const blocks = typeof msg.content === 'string' ? [] : msg.content;
    const text = typeof msg.content === 'string'
      ? msg.content
      : textFromBlocks(blocks);
    const thinking = typeof msg.content === 'string'
      ? undefined
      : thinkingFromBlocks(blocks);
    const toolCalls = typeof msg.content === 'string'
      ? undefined
      : hydrateToolCalls(blocks, messages[i + 1]);

    if (!text && !thinking && (!toolCalls || toolCalls.length === 0)) {
      continue;
    }

    out.push({
      id: `msg_${msg.createdAt ?? i}_${i}`,
      role: 'assistant',
      content: text,
      timestamp: msg.createdAt ?? Date.now(),
      status: 'completed',
      delivery: 'turn',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      thinking,
    });
  }

  return out;
}

export function toAgentChatMessagesFromEvents(events: SessionEvent[]): AgentChatMessage[] {
  const out: AgentChatMessage[] = [];
  const openTools = new Map<string, { tool: ChatToolCall; step: AgentChatStep; message: AgentChatMessage }>();
  let currentAssistant: AgentChatMessage | null = null;
  let pendingTimeline: AgentChatTimelineItem[] = [];
  let pendingEvents: AgentChatTimelineEvent[] = [];
  let pendingInference: AgentChatInference | undefined;

  const pushTimelineEvent = (event: AgentChatTimelineEvent) => {
    if (currentAssistant) {
      currentAssistant.events = [...(currentAssistant.events ?? []), event];
      currentAssistant.timeline = [...(currentAssistant.timeline ?? []), { type: 'event', event }];
    } else {
      pendingEvents = [...pendingEvents, event];
      pendingTimeline = [...pendingTimeline, { type: 'event', event }];
    }
  };

  const ensureAssistantForActivity = (event: SessionEvent): AgentChatMessage => {
    if (currentAssistant) return currentAssistant;
    const message: AgentChatMessage = {
      id: `activity_${event.id}`,
      role: 'assistant',
      content: '',
      timestamp: event.timestamp,
      status: 'completed',
      delivery: 'turn',
      events: pendingEvents.length > 0 ? pendingEvents : undefined,
      timeline: pendingTimeline.length > 0 ? pendingTimeline : undefined,
    };
    out.push(message);
    currentAssistant = message;
    pendingEvents = [];
    pendingTimeline = [];
    return message;
  };

  const ensureActivityStep = (message: AgentChatMessage, event: SessionEvent): AgentChatStep => {
    const existing = message.steps?.at(-1);
    if (existing) return existing;
    const step: AgentChatStep = {
      id: `step_${event.id}`,
      toolCalls: [],
      status: 'completed',
      inference: pendingInference,
    };
    message.steps = [...(message.steps ?? []), step];
    message.timeline = [...(message.timeline ?? []), { type: 'step', step }];
    if (pendingInference) {
      message.inferences = [...(message.inferences ?? []), pendingInference];
      pendingInference = undefined;
    }
    return step;
  };

  for (const event of events) {
    switch (event.type) {
      case 'user_message': {
        const message = chatUserMessageFromEvent(event, out.length);
        if (message) {
          out.push(message);
          currentAssistant = null;
        }
        break;
      }

      case 'assistant_message': {
        const step = chatStepFromAssistantEvent(event, pendingInference);
        const message: AgentChatMessage = {
          id: `msg_${event.id}`,
          role: 'assistant',
          content: step?.text ?? '',
          timestamp: event.timestamp,
          status: 'completed',
          delivery: 'turn',
          steps: step ? [step] : undefined,
          events: pendingEvents.length > 0 ? pendingEvents : undefined,
          timeline: [
            ...pendingTimeline,
            ...(step ? [{ type: 'step' as const, step }] : []),
          ],
          inferences: pendingInference ? [pendingInference] : undefined,
          thinking: step?.thinking,
          toolCalls: step && step.toolCalls.length > 0 ? step.toolCalls : undefined,
        };
        if (message.content || message.steps?.length || message.events?.length) {
          out.push(message);
          currentAssistant = message;
          if (step) {
            for (const tool of step.toolCalls) {
              if (tool.toolUseId) openTools.set(tool.toolUseId, { tool, step, message });
            }
          }
        }
        pendingInference = undefined;
        pendingEvents = [];
        pendingTimeline = [];
        break;
      }

      case 'tool_use_start':
      case 'tool_use': {
        const message = ensureAssistantForActivity(event);
        const step = ensureActivityStep(message, event);
        const existing = event.toolUseId ? openTools.get(event.toolUseId) : undefined;
        if (!existing) {
          const tool: ChatToolCall = {
            name: event.name,
            input: event.input,
            toolUseId: event.toolUseId,
          };
          step.toolCalls = [...step.toolCalls, tool];
          message.toolCalls = [...(message.toolCalls ?? []), tool];
          if (event.toolUseId) openTools.set(event.toolUseId, { tool, step, message });
        }
        break;
      }

      case 'tool_use_end':
      case 'tool_result': {
        const ref = openTools.get(event.toolUseId);
        if (ref) {
          ref.tool.result = event.type === 'tool_use_end' ? event.output : event.content;
          ref.tool.isError = event.isError;
        } else {
          const message = ensureAssistantForActivity(event);
          const step = ensureActivityStep(message, event);
          const tool: ChatToolCall = {
            name: event.toolUseId,
            input: {},
            toolUseId: event.toolUseId,
            result: event.type === 'tool_use_end' ? event.output : event.content,
            isError: event.isError,
          };
          step.toolCalls = [...step.toolCalls, tool];
          message.toolCalls = [...(message.toolCalls ?? []), tool];
        }
        break;
      }

      case 'thinking': {
        const message = ensureAssistantForActivity(event);
        const step = ensureActivityStep(message, event);
        step.thinking = `${step.thinking ?? ''}${event.thinking}`;
        message.thinking = `${message.thinking ?? ''}${event.thinking}`;
        break;
      }

      case 'api_response':
        pendingInference = {
          model: event.model,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
          cacheWriteTokens: event.usage.cacheWriteTokens,
          stopReason: event.stopReason,
        };
        pushTimelineEvent(agentTimelineEventFromSessionEvent(event));
        break;

      case 'query_start':
      case 'api_request':
      case 'api_call':
      case 'compaction_marker':
      case 'memory_flush':
      case 'guard_decision':
      case 'approval_request':
      case 'approval_decision':
      case 'delegate_start':
      case 'delegate_end':
      case 'crash_recovered':
        pushTimelineEvent(agentTimelineEventFromSessionEvent(event));
        break;

      default:
        break;
    }
  }

  return out.filter((message) =>
    message.role === 'user' ||
    message.content ||
    message.timeline?.length ||
    message.steps?.length ||
    message.toolCalls?.length,
  );
}

export function deriveTitleFromSession(session: Session): string | undefined {
  const firstUser = session.messages.find((message) => message.role === 'user' && typeof message.content === 'string');
  if (!firstUser || typeof firstUser.content !== 'string') return undefined;
  return truncateTitle(firstUser.content);
}

export function deriveTitleFromMessages(messages: AgentChatMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === 'user' && message.content && message.content !== '(image)');
  if (!firstUser) return undefined;
  return truncateTitle(firstUser.content);
}

export function deriveTitleFromEvents(events?: SessionEvent[]): string | undefined {
  if (!events) return undefined;
  for (const event of events) {
    if (event.type !== 'user_message') continue;
    const text = typeof event.content === 'string'
      ? event.content
      : event.content.map(previewTextForBlock).join(' ');
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized) return truncateTitle(normalized);
  }
  return undefined;
}

function chatUserMessageFromEvent(
  event: Extract<SessionEvent, { type: 'user_message' }>,
  index: number,
): AgentChatMessage | null {
  return agentUserMessageFromContent(event.content, `msg_${event.id || index}`, event.timestamp);
}

function agentUserMessageFromContent(
  content: string | ContentBlock[],
  id: string,
  timestamp: number,
): AgentChatMessage | null {
  if (typeof content === 'string') {
    return {
      id,
      role: 'user',
      content,
      timestamp,
      status: 'completed',
      delivery: 'turn',
    };
  }

  const text = textFromBlocks(content);
  const displayBlocks = content
    .filter((block): block is Extract<ContentBlock, { type: 'image' }> | AnnotationContent =>
      block.type === 'image' || block.type === 'annotation',
    )
    .map((block) => block.type === 'image'
      ? ({ type: 'image' as const, data: block.data, mediaType: block.mediaType })
      : block);

  if (!text && displayBlocks.length === 0) return null;
  return {
    id,
    role: 'user',
    content: text || (displayBlocks.some((block) => block.type === 'annotation') ? '(annotation)' : '(image)'),
    timestamp,
    status: 'completed',
    delivery: 'turn',
    blocks: displayBlocks.length > 0 ? displayBlocks : undefined,
  };
}

function chatStepFromAssistantEvent(
  event: Extract<SessionEvent, { type: 'assistant_message' }>,
  inference?: AgentChatInference,
): AgentChatStep | null {
  const text = textFromBlocks(event.content);
  const thinking = thinkingFromBlocks(event.content);
  const toolCalls: ChatToolCall[] = event.content
    .filter((block): block is ToolUseContent => block.type === 'tool_use')
    .map((tool) => ({
      name: tool.name,
      input: tool.input,
      toolUseId: tool.id,
    }));

  if (!text && !thinking && toolCalls.length === 0 && !inference) return null;
  return {
    id: `step_${event.id}`,
    text: text || undefined,
    thinking,
    toolCalls,
    inference,
    status: 'completed',
  };
}

function hydrateToolCalls(blocks: ContentBlock[], nextMessage?: Session['messages'][number]): ChatToolCall[] | undefined {
  const toolUses = blocks.filter((block): block is ToolUseContent => block.type === 'tool_use');
  if (toolUses.length === 0) return undefined;

  const resultById = new Map<string, ToolResultContent>();
  if (nextMessage?.role === 'user' && Array.isArray(nextMessage.content)) {
    for (const block of nextMessage.content) {
      if (block.type === 'tool_result') {
        resultById.set(block.toolUseId, block);
      }
    }
  }

  return toolUses.map((toolUse) => {
    const result = resultById.get(toolUse.id);
    return {
      name: toolUse.name,
      input: toolUse.input,
      toolUseId: toolUse.id,
      isError: result?.isError,
      result: result?.content,
    };
  });
}

function truncateTitle(value: string): string {
  return value.length > 30 ? `${value.slice(0, 30)}...` : value;
}
