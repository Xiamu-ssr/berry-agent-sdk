// ============================================================
// Berry Agent SDK — Observe: Shared API Types
// ============================================================
// Single source of truth for all observe API request/response types.
// Used by: server.ts (response), UI (fetch result), analyzer.ts (implementation).
// Import from '@berry-agent/observe' or '@berry-agent/observe/api-types'.
//
// All view-model types are derived from zod schemas. Exported `*Schema`
// constants let hosts/UI runtime-validate aggregate payloads at the API
// boundary; exported types remain identical to the previous hand-written
// interfaces so existing consumers compile unchanged.

import { z } from 'zod';

// ----- API Paths (single source of truth) -----

export const OBSERVE_API_PATHS = {
  COST: '/cost',
  COST_BY_MODEL: '/cost/by-model',
  COST_TREND: '/cost/trend',
  CACHE: '/cache',
  TOOLS: '/tools',
  GUARD: '/guard',
  GUARD_DECISIONS: '/guard/decisions',
  GUARD_BY_TOOL: '/guard/by-tool',
  COMPACTION: '/compaction',
  COMPACTION_LIST: '/compaction/list',
  INFERENCES: '/inferences',
  INFERENCE_DETAIL: '/inferences/:id',
  SESSIONS: '/sessions',
  SESSION_DETAIL: '/sessions/:id',
  AGENTS: '/agents',
  AGENT_DETAIL: '/agents/:id',
  AGENT_SESSIONS: '/agents/:id/sessions',
  TURNS: '/turns',
  TURN_DETAIL: '/turns/:id',
  TURN_INFERENCES: '/turns/:id/inferences',
  CLEANUP: '/cleanup',
  METRICS_TURN: '/metrics/turn/:turnId',
  METRICS_SESSION: '/metrics/session/:sessionId',
  METRICS_AGENT: '/metrics/agent/:agentId',
} as const;

// ----- Primitive helpers -----

const nonNegativeNumber = z.number().nonnegative();
const nonNegativeInt = z.number().int().nonnegative();
const finiteNumber = z.number().finite();
const ratio01 = z.number().min(0).max(1);
const nullableString = z.string().nullable();

// ----- Filter (request) -----

export const dimensionFilterSchema = z.object({
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  turnId: z.string().optional(),
}).strip();
export type DimensionFilter = z.infer<typeof dimensionFilterSchema>;

// ----- Cost -----

export const costBreakdownSchema = z.object({
  inputCost: nonNegativeNumber,
  outputCost: nonNegativeNumber,
  cacheSavings: nonNegativeNumber,
  totalCost: nonNegativeNumber,
  callCount: nonNegativeInt,
}).strip();
export type CostBreakdown = z.infer<typeof costBreakdownSchema>;

export const costByModelSchema = z.object({
  model: z.string(),
  totalCost: nonNegativeNumber,
  callCount: nonNegativeInt,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
}).strip();
export type CostByModel = z.infer<typeof costByModelSchema>;

export const costTrendPointSchema = z.object({
  date: z.string(),
  totalCost: nonNegativeNumber,
  callCount: nonNegativeInt,
}).strip();
export type CostTrendPoint = z.infer<typeof costTrendPointSchema>;

// ----- Cache -----

export const cacheEfficiencySchema = z.object({
  totalCacheReadTokens: nonNegativeInt,
  totalCacheWriteTokens: nonNegativeInt,
  totalInputTokens: nonNegativeInt,
  cacheHitRate: ratio01,
  totalSavings: nonNegativeNumber,
}).strip();
export type CacheEfficiency = z.infer<typeof cacheEfficiencySchema>;

// ----- Tools / Guard -----

export const toolStatSchema = z.object({
  name: z.string(),
  callCount: nonNegativeInt,
  errorCount: nonNegativeInt,
  avgDurationMs: nonNegativeNumber,
  totalDurationMs: nonNegativeNumber,
}).strip();
export type ToolStat = z.infer<typeof toolStatSchema>;

export const guardStatSchema = z.object({
  allowCount: nonNegativeInt,
  denyCount: nonNegativeInt,
  modifyCount: nonNegativeInt,
  avgDurationMs: nonNegativeNumber,
}).strip();
export type GuardStat = z.infer<typeof guardStatSchema>;

export const guardDecisionRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  llmCallId: nullableString,
  turnId: nullableString,
  toolName: z.string(),
  input: z.string(),
  decision: z.string(),
  reason: nullableString,
  modifiedInput: nullableString,
  callIndex: nonNegativeInt,
  durationMs: nonNegativeNumber,
  timestamp: finiteNumber,
}).strip();
export type GuardDecisionRecord = z.infer<typeof guardDecisionRecordSchema>;

export const guardByToolStatSchema = z.object({
  toolName: z.string(),
  allowCount: nonNegativeInt,
  denyCount: nonNegativeInt,
  modifyCount: nonNegativeInt,
  totalCount: nonNegativeInt,
  denyRate: ratio01,
}).strip();
export type GuardByToolStat = z.infer<typeof guardByToolStatSchema>;

// ----- Compaction -----

export const compactionRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  triggerReason: z.string(),
  contextBefore: nonNegativeInt,
  contextAfter: nonNegativeInt,
  thresholdPct: nonNegativeNumber,
  contextWindow: nonNegativeInt,
  layersApplied: z.string(),
  durationMs: nonNegativeNumber,
  tokensFreed: z.number(),
  timestamp: finiteNumber,
}).strip();
export type CompactionRecord = z.infer<typeof compactionRecordSchema>;

export const compactionStatsSchema = z.object({
  totalCount: nonNegativeInt,
  avgTokensFreed: z.number(),
  avgDurationMs: nonNegativeNumber,
  avgThresholdPct: nonNegativeNumber,
  avgReductionPct: z.number(),
  byTrigger: z.array(z.object({ reason: z.string(), count: nonNegativeInt }).strip()),
  byLayer: z.array(z.object({ layer: z.string(), count: nonNegativeInt }).strip()),
}).strip();
export type CompactionStats = z.infer<typeof compactionStatsSchema>;

// ----- Inferences -----

const inferenceToolCallSchema = z.object({
  name: z.string(),
  input: z.string(),
  output: z.string(),
  isError: z.boolean(),
  durationMs: nonNegativeNumber,
}).strip();

export const inferenceRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: nullableString,
  turnId: nullableString,
  provider: z.string(),
  model: z.string(),
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  cacheReadTokens: nonNegativeInt,
  cacheWriteTokens: nonNegativeInt,
  totalCost: nonNegativeNumber,
  latencyMs: nonNegativeNumber,
  stopReason: z.string(),
  messageCount: nonNegativeInt,
  toolDefCount: nonNegativeInt,
  systemBlockCount: nonNegativeInt,
  hasImages: z.boolean(),
  requestSystem: nullableString,
  requestMessages: nullableString,
  requestTools: nullableString,
  responseContent: nullableString,
  providerRequest: nullableString,
  providerResponse: nullableString,
  providerDetail: nullableString,
  timestamp: finiteNumber,
  toolCalls: z.array(inferenceToolCallSchema),
  guardDecisions: z.array(guardDecisionRecordSchema),
}).strip();
export type InferenceRecord = z.infer<typeof inferenceRecordSchema>;

// ----- Turn / Session -----

export const turnSummarySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: nullableString,
  prompt: nullableString,
  startTime: finiteNumber,
  endTime: finiteNumber.nullable(),
  llmCallCount: nonNegativeInt,
  toolCallCount: nonNegativeInt,
  totalCost: nonNegativeNumber,
  status: z.string(),
  recoveredFromCrash: z.boolean(),
  orphanedToolCount: nonNegativeInt,
  previousTurnId: nullableString,
  cost: costBreakdownSchema,
  cache: cacheEfficiencySchema,
  guard: guardStatSchema,
}).strip();
export type TurnSummary = z.infer<typeof turnSummarySchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  agentId: nullableString,
  startTime: finiteNumber,
  endTime: finiteNumber.nullable(),
  totalCost: nonNegativeNumber,
  status: z.string(),
  llmCallCount: nonNegativeInt,
  toolCallCount: nonNegativeInt,
  guardDecisionCount: nonNegativeInt,
  compactionCount: nonNegativeInt,
  eventCount: nonNegativeInt,
}).strip();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

// ----- Agents -----

export const agentStatsSchema = z.object({
  agentId: z.string(),
  sessionCount: nonNegativeInt,
  totalCost: nonNegativeNumber,
  llmCallCount: nonNegativeInt,
  toolCallCount: nonNegativeInt,
  avgCostPerSession: nonNegativeNumber,
}).strip();
export type AgentStats = z.infer<typeof agentStatsSchema>;

export const agentDetailSchema = agentStatsSchema.extend({
  cost: costBreakdownSchema,
  cache: cacheEfficiencySchema,
  guard: guardStatSchema,
  recentSessions: z.array(sessionSummarySchema),
}).strip();
export type AgentDetail = z.infer<typeof agentDetailSchema>;

// ----- Cleanup -----

export const cleanupResultSchema = z.object({
  removed: nonNegativeInt,
}).strip();
export type CleanupResult = z.infer<typeof cleanupResultSchema>;

// ----- Derived Metrics -----

export const turnMetricsSchema = z.object({
  turnId: z.string(),
  toolSuccessRate: ratio01,
  toolCallCount: nonNegativeInt,
  guardDenyRate: ratio01,
  guardDecisionCount: nonNegativeInt,
  totalInputTokens: nonNegativeInt,
  totalOutputTokens: nonNegativeInt,
  estimatedCostUsd: nonNegativeNumber,
  durationMs: nonNegativeNumber,
  llmCallCount: nonNegativeInt,
}).strip();
export type TurnMetrics = z.infer<typeof turnMetricsSchema>;

export const sessionMetricsSchema = z.object({
  sessionId: z.string(),
  turnsCount: nonNegativeInt,
  totalCost: nonNegativeNumber,
  totalInputTokens: nonNegativeInt,
  totalOutputTokens: nonNegativeInt,
  toolDistribution: z.record(nonNegativeInt),
  avgToolSuccessRate: ratio01,
  avgTurnDurationMs: nonNegativeNumber,
  compactionCount: nonNegativeInt,
  modelDistribution: z.record(nonNegativeInt),
}).strip();
export type SessionMetrics = z.infer<typeof sessionMetricsSchema>;

export const agentMetricsSchema = z.object({
  agentId: z.string(),
  sessionCount: nonNegativeInt,
  totalCost: nonNegativeNumber,
  totalTokens: nonNegativeInt,
  avgSessionCost: nonNegativeNumber,
  topTools: z.array(z.object({ name: z.string(), count: nonNegativeInt }).strip()),
  modelUsage: z.record(nonNegativeInt),
  // Per-model cost/token split — the same llm_calls rows that feed modelUsage,
  // carrying the real cost + tokens each model accounts for. The model rung of
  // the consumption layering (product -> agent -> model); every number is a
  // pure GROUP BY sum, never an estimate.
  modelBreakdown: z.array(z.object({
    model: z.string(),
    calls: nonNegativeInt,
    totalCost: nonNegativeNumber,
    totalTokens: nonNegativeInt,
  }).strip()).default([]),
  // Per-day cost/call trend — the time rung of the consumption layering. The
  // cumulative fields above say "how much"; this says "how fast right now".
  // date is a UTC YYYY-MM-DD bucket over llm_calls.timestamp; ascending in time.
  // Pure GROUP BY over the same rows — never an estimate.
  dailyTrend: z.array(z.object({
    date: z.string(),
    calls: nonNegativeInt,
    totalCost: nonNegativeNumber,
  }).strip()).default([]),
}).strip();
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;

export const stabilityMetricsSchema = z.object({
  totalTurns: nonNegativeInt,
  recoveredTurns: nonNegativeInt,
  crashRate: ratio01,
  totalOrphanedTools: nonNegativeInt,
  topOrphanedTools: z.array(z.object({ name: z.string(), count: nonNegativeInt }).strip()),
}).strip();
export type StabilityMetrics = z.infer<typeof stabilityMetricsSchema>;
