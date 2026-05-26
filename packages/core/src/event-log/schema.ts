// ============================================================
// Berry Agent SDK — Session Event Log Schemas
// ============================================================

import { z } from 'zod';
import { SystemPromptCacheMode } from '@berry-agent/small-shared-core';
import { COMPACTION_TRIGGER_REASON_VALUES } from '../constants.js';
import type { CompactionTriggerReason } from '../constants.js';
import { zContentBlock } from '../schema.js';
import type { DelegateResult, QueryResult } from '../agent-runtime-types.js';
import type { Message } from '../content-types.js';
import type { ToolGuardDecision } from '../tool-types.js';
import type { TokenUsage } from '../provider-types.js';
import type { SessionEvent } from './types.js';

const zBaseEvent = {
  id: z.string().min(1),
  timestamp: z.number(),
  turnId: z.string().optional(),
  sessionId: z.string().min(1),
};

const zMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(zContentBlock)]),
  compacted: z.boolean().optional(),
  createdAt: z.number().optional(),
}) satisfies z.ZodType<Message>;

const zUnknownRecord = z.record(z.unknown());
const zTokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
}).strict() satisfies z.ZodType<TokenUsage>;

const zQueryResult = z.object({
  text: z.string(),
  sessionId: z.string(),
  usage: zTokenUsage,
  totalUsage: zTokenUsage,
  toolCalls: z.number(),
  compacted: z.boolean(),
  error: z.string().optional(),
}).strict() satisfies z.ZodType<QueryResult>;

const zDelegateResult = z.object({
  text: z.string(),
  usage: zTokenUsage,
  turns: z.number(),
  toolCalls: z.number(),
}).strict() satisfies z.ZodType<DelegateResult>;
const zCompactionTriggerReason = z.custom<CompactionTriggerReason>(
  (value) => COMPACTION_TRIGGER_REASON_VALUES.includes(value as CompactionTriggerReason),
);

const zToolGuardDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }).strict(),
  z.object({ action: z.literal('deny'), reason: z.string() }).strict(),
  z.object({ action: z.literal('modify'), input: zUnknownRecord }).strict(),
]) satisfies z.ZodType<ToolGuardDecision>;

const zSystemPromptBlock = z.object({
  text: z.string(),
  cache: z.nativeEnum(SystemPromptCacheMode),
}).strict();

const zContextManifest = z.object({
  promptPackVersion: z.string(),
  messageSource: z.literal('messages.json'),
  messageCount: z.number(),
  systemBlockCount: z.number(),
  systemBlockHashes: z.array(z.string()),
  toolCount: z.number(),
  toolsHash: z.string(),
}).strict();

const zSessionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...zBaseEvent, type: z.literal('user_message'), content: z.union([z.string(), z.array(zContentBlock)]) }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('assistant_message'), content: z.array(zContentBlock) }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('tool_use'), name: z.string(), toolUseId: z.string(), input: zUnknownRecord }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('tool_result'), toolUseId: z.string(), content: z.string(), isError: z.boolean() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('thinking'), thinking: z.string() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('query_start'), prompt: z.union([z.string(), z.array(zContentBlock)]) }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('query_end'), result: zQueryResult }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('compaction_marker'),
    strategy: z.string(),
    triggerReason: zCompactionTriggerReason.optional(),
    tokensFreed: z.number(),
    contextBefore: z.number().optional(),
    contextAfter: z.number().optional(),
    thresholdPct: z.number().optional(),
    contextWindow: z.number().optional(),
    layersApplied: z.array(z.string()).optional(),
    durationMs: z.number().optional(),
  }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('guard_decision'), toolName: z.string(), decision: zToolGuardDecision }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('approval_request'),
    approvalId: z.string(),
    agentId: z.string().optional(),
    toolName: z.string(),
    input: zUnknownRecord,
    callIndex: z.number(),
    reason: z.string(),
    cwd: z.string(),
    model: z.string(),
  }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('approval_decision'),
    approvalId: z.string(),
    approved: z.boolean(),
    note: z.string().optional(),
    toolName: z.string().optional(),
    agentId: z.string().optional(),
  }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('delegate_start'), message: z.string() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('delegate_end'), result: zDelegateResult }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('session_start'),
    systemPrompt: z.array(zSystemPromptBlock),
    projectContextSnapshot: z.string().optional(),
    toolsAvailable: z.array(z.string()),
    guardEnabled: z.boolean(),
    providerType: z.string(),
    model: z.string(),
    compactionConfig: zUnknownRecord.optional(),
  }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('messages_snapshot'),
    messages: z.array(zMessage),
    reason: z.enum(['turn_end', 'manual_compact', 'auto_compact', 'fork']),
  }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('api_request'),
    requestId: z.string(),
    model: z.string(),
    messages: z.array(zMessage),
    tools: z.array(z.object({ name: z.string(), description: z.string() }).strict()),
    params: zUnknownRecord,
    contextManifest: zContextManifest.optional(),
  }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('api_response'),
    requestId: z.string(),
    model: z.string(),
    content: z.array(zContentBlock),
    stopReason: z.string(),
    usage: zTokenUsage,
  }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('tool_use_start'), toolUseId: z.string(), name: z.string(), input: zUnknownRecord }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('tool_use_end'), toolUseId: z.string(), output: z.string(), isError: z.boolean() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('api_call'), model: z.string(), inputTokens: z.number(), outputTokens: z.number() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('memory_flush'), reason: z.literal('pre_compact'), charsSaved: z.number() }).strict(),
  z.object({ ...zBaseEvent, type: z.literal('metadata'), key: z.string(), value: z.unknown() }).strict(),
  z.object({
    ...zBaseEvent,
    type: z.literal('crash_recovered'),
    artifactCount: z.number(),
    orphanedTools: z.array(z.object({
      toolUseId: z.string(),
      name: z.string(),
      input: zUnknownRecord,
      startedAt: z.number(),
      startEventId: z.string(),
    }).strict()),
    interjected: z.boolean(),
    crashedTurnId: z.string().optional(),
  }).strict(),
]);

export const zSessionEvent = zSessionEventSchema as unknown as z.ZodType<SessionEvent>;
