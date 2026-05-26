import type {
  AgentEvent,
} from './agent-runtime-types.js';
import type { SessionEvent } from './event-log/types.js';
import type { AgentChatTimelineEvent } from './chat-types.js';

/** Convert a live SDK AgentEvent into the same UI timeline event shape used by session replay. */
export function timelineEventFromAgentEvent(
  event: AgentEvent,
  options: { id?: string; timestamp?: number } = {},
): AgentChatTimelineEvent | null {
  const timestamp = options.timestamp ?? Date.now();
  const base = {
    id: options.id ?? `live_${timestamp}_${event.type}`,
    timestamp,
    collapsed: true,
  };

  switch (event.type) {
    case 'query_start':
      return { ...base, kind: 'query', title: '用户提示已提交' };
    case 'api_call':
      return {
        ...base,
        kind: 'api_call',
        title: '调用模型',
        detail: `${event.messages} messages · ${event.tools} tools`,
        tone: 'info',
      };
    case 'api_response':
      return {
        ...base,
        kind: 'api_response',
        title: `模型响应完成：${event.model}`,
        detail: `${event.usage.inputTokens}↓ ${event.usage.outputTokens}↑ · ${event.stopReason}`,
        tone: 'good',
      };
    case 'compaction':
      return {
        ...base,
        kind: 'compaction',
        title: '上下文已压缩',
        detail: `释放 ${event.tokensFreed.toLocaleString()} tokens`,
        tone: 'warn',
      };
    case 'memory_flush':
      return {
        ...base,
        kind: 'memory',
        title: '记忆已写入',
        detail: `${event.reason} · ${event.charsSaved} chars`,
        tone: 'good',
      };
    case 'guard_decision':
      return {
        ...base,
        kind: 'guard',
        title: `安全策略：${event.decision.action}`,
        detail: event.toolName,
        tone: event.decision.action === 'deny' ? 'bad' : 'info',
      };
    case 'delegate_start':
      return { ...base, kind: 'delegate', title: '委派任务开始', detail: event.message, tone: 'info' };
    case 'delegate_end':
      return { ...base, kind: 'delegate', title: '委派任务完成', tone: 'good' };
    case 'crash_recovered':
      return { ...base, kind: 'system', title: '已恢复崩溃会话', detail: `${event.artifactCount} artifacts`, tone: 'warn' };
    case 'status_change':
      return event.detail ? { ...base, kind: 'status', title: `状态：${event.status}`, detail: event.detail } : null;
    default:
      return null;
  }
}

export function agentTimelineEventFromSessionEvent(event: SessionEvent): AgentChatTimelineEvent {
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    collapsed: true,
  };
  switch (event.type) {
    case 'query_start':
      return { ...base, kind: 'query', title: '用户提示已提交' };
    case 'api_call':
      return {
        ...base,
        kind: 'api_call',
        title: '调用模型',
        detail: `${event.inputTokens}↓ ${event.outputTokens}↑`,
        tone: 'info',
      };
    case 'api_request':
      return {
        ...base,
        kind: 'api_call',
        title: '调用模型',
        detail: `${event.messages.length} messages · ${event.tools.length} tools`,
        tone: 'info',
      };
    case 'api_response':
      return {
        ...base,
        kind: 'api_response',
        title: `模型响应完成：${event.model}`,
        detail: `${event.usage.inputTokens}↓ ${event.usage.outputTokens}↑ · ${event.stopReason}`,
        tone: 'good',
      };
    case 'compaction_marker':
      return {
        ...base,
        kind: 'compaction',
        title: '上下文已压缩',
        detail: `释放 ${event.tokensFreed.toLocaleString()} tokens`,
        tone: 'warn',
      };
    case 'memory_flush':
      return { ...base, kind: 'memory', title: '记忆已写入', detail: `${event.reason} · ${event.charsSaved} chars`, tone: 'good' };
    case 'guard_decision':
      return {
        ...base,
        kind: 'guard',
        title: `安全策略：${event.decision.action}`,
        detail: event.toolName,
        tone: event.decision.action === 'deny' ? 'bad' : 'info',
      };
    case 'approval_request':
      return {
        ...base,
        kind: 'guard',
        title: '等待人工审批',
        detail: event.toolName,
        tone: 'warn',
      };
    case 'approval_decision':
      return {
        ...base,
        kind: 'guard',
        title: event.approved ? '人工审批通过' : '人工审批拒绝',
        detail: event.toolName ?? event.approvalId,
        tone: event.approved ? 'good' : 'bad',
      };
    case 'delegate_start':
      return { ...base, kind: 'delegate', title: '委派任务开始', detail: event.message, tone: 'info' };
    case 'delegate_end':
      return { ...base, kind: 'delegate', title: '委派任务完成', tone: 'good' };
    case 'crash_recovered':
      return { ...base, kind: 'system', title: '已恢复崩溃会话', detail: `${event.artifactCount} artifacts`, tone: 'warn' };
    default:
      return { ...base, kind: 'system', title: event.type };
  }
}
