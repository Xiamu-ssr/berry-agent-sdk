import type { AnnotationContent } from './content-types.js';

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  toolUseId?: string;
  expanded?: boolean;
}

export interface AgentChatInference {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  stopReason: string;
  cost?: number;
}

export interface AgentChatTimelineEvent {
  id: string;
  kind:
    | 'query'
    | 'api_call'
    | 'api_response'
    | 'compaction'
    | 'status'
    | 'memory'
    | 'guard'
    | 'delegate'
    | 'model'
    | 'system';
  title: string;
  detail?: string;
  timestamp: number;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
  collapsed?: boolean;
}

export interface AgentChatStep {
  id: string;
  thinking?: string;
  text?: string;
  toolCalls: ChatToolCall[];
  inference?: AgentChatInference;
  status: 'streaming' | 'completed';
}

export type AgentChatTimelineItem =
  | { type: 'event'; event: AgentChatTimelineEvent }
  | { type: 'step'; step: AgentChatStep };

export type AgentChatMessageStatus = 'pending' | 'streaming' | 'completed' | 'queued' | 'failed';
export type AgentChatMessageDelivery = 'turn' | 'interject';

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  status?: AgentChatMessageStatus;
  delivery?: AgentChatMessageDelivery;
  requestId?: string;
  toolCalls?: ChatToolCall[];
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number };
  inferences?: AgentChatInference[];
  steps?: AgentChatStep[];
  events?: AgentChatTimelineEvent[];
  timeline?: AgentChatTimelineItem[];
  blocks?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mediaType: string }
    | AnnotationContent
  >;
}

export type AgentSessionStatus = 'idle' | 'running' | 'interrupted';

export interface AgentSessionView {
  id: string;
  title?: string;
  messages: AgentChatMessage[];
  createdAt: number;
  lastActiveAt: number;
  agentId?: string;
  status: AgentSessionStatus;
}
