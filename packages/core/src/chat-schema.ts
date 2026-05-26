// ============================================================
// Berry Agent SDK - Chat / Session View Schemas
// ============================================================

import { z } from 'zod';
import type {
  AgentChatInference,
  AgentChatMessage,
  AgentChatStep,
  AgentChatTimelineEvent,
  AgentChatTimelineItem,
  AgentSessionView,
  ChatToolCall,
} from './chat-types.js';
import { zUserContentBlock } from './schema.js';

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

export const zChatToolCall = z.object({
  name: z.string(),
  input: z.record(z.unknown()),
  result: z.string().optional(),
  isError: z.boolean().optional(),
  toolUseId: z.string().optional(),
  expanded: z.boolean().optional(),
}) satisfies z.ZodType<ChatToolCall>;

export const zAgentChatInference = z.object({
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  stopReason: z.string(),
  cost: z.number().optional(),
}) satisfies z.ZodType<AgentChatInference>;

export const zAgentChatTimelineEvent = z.object({
  id: z.string(),
  kind: z.enum([
    'query',
    'api_call',
    'api_response',
    'compaction',
    'status',
    'memory',
    'guard',
    'delegate',
    'model',
    'system',
  ]),
  title: z.string(),
  detail: z.string().optional(),
  timestamp: z.number(),
  tone: z.enum(['neutral', 'good', 'warn', 'bad', 'info']).optional(),
  collapsed: z.boolean().optional(),
}) satisfies z.ZodType<AgentChatTimelineEvent>;

export const zAgentChatStep = z.object({
  id: z.string(),
  thinking: z.string().optional(),
  text: z.string().optional(),
  toolCalls: z.array(zChatToolCall),
  inference: zAgentChatInference.optional(),
  status: z.enum(['streaming', 'completed']),
}) satisfies z.ZodType<AgentChatStep>;

export const zAgentChatTimelineItem: z.ZodType<AgentChatTimelineItem> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: zAgentChatTimelineEvent }),
  z.object({ type: z.literal('step'), step: zAgentChatStep }),
]);

export const zAgentChatMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.number(),
  status: z.enum(['pending', 'streaming', 'completed', 'queued', 'failed']).optional(),
  delivery: z.enum(['turn', 'interject']).optional(),
  requestId: z.string().optional(),
  toolCalls: z.array(zChatToolCall).optional(),
  thinking: z.string().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).optional(),
  inferences: z.array(zAgentChatInference).optional(),
  steps: z.array(zAgentChatStep).optional(),
  events: z.array(zAgentChatTimelineEvent).optional(),
  timeline: z.array(zAgentChatTimelineItem).optional(),
  blocks: z.array(zUserContentBlock).optional(),
}) satisfies z.ZodType<AgentChatMessage>;

export const zAgentSessionView = z.object({
  id: z.string(),
  title: z.string().optional(),
  messages: z.array(zAgentChatMessage),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  agentId: z.string().optional(),
  status: z.enum(['idle', 'running', 'interrupted']),
}) satisfies z.ZodType<AgentSessionView>;
