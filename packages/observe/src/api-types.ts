// ============================================================
// Berry Agent SDK — Observe: Shared API Types
// ============================================================
// Single source of truth for all observe API request/response types.
// Used by: server.ts (response), UI (fetch result), analyzer.ts (implementation).
// Import from '@berry-agent/observe' or '@berry-agent/observe/api-types'.

// ----- API Paths (single source of truth) -----

export const OBSERVE_API_PATHS = {
  COST: '/cost',
  COST_BY_MODEL: '/cost/by-model',
  COST_TREND: '/cost/trend',
  CACHE: '/cache',
  TOOLS: '/tools',
  GUARD: '/guard',
  GUARD_DECISIONS: '/guard/decisions',
  COMPACTION: '/compaction',
  COMPACTION_LIST: '/compaction/list',
  INFERENCES: '/inferences',
  INFERENCE_DETAIL: '/inferences/:id',
  SESSIONS: '/sessions',
  SESSION_DETAIL: '/sessions/:id',
  AGENTS: '/agents',
  CLEANUP: '/cleanup',
} as const;

// ----- Response Types -----

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheSavings: number;
  totalCost: number;
  callCount: number;
}

export interface CostByModel {
  model: string;
  totalCost: number;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostTrendPoint {
  date: string;
  totalCost: number;
  callCount: number;
}

export interface CacheEfficiency {
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalInputTokens: number;
  cacheHitRate: number;
  totalSavings: number;
}

export interface ToolStat {
  name: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

export interface GuardStat {
  allowCount: number;
  denyCount: number;
  modifyCount: number;
  avgDurationMs: number;
}

export interface GuardDecisionRecord {
  id: string;
  sessionId: string;
  llmCallId: string | null;
  toolName: string;
  input: string;
  decision: string;
  reason: string | null;
  modifiedInput: string | null;
  callIndex: number;
  durationMs: number;
  timestamp: number;
}

export interface CompactionRecord {
  id: string;
  sessionId: string;
  triggerReason: string;
  contextBefore: number;
  contextAfter: number;
  thresholdPct: number;
  contextWindow: number;
  layersApplied: string;
  durationMs: number;
  tokensFreed: number;
  timestamp: number;
}

export interface CompactionStats {
  totalCount: number;
  avgTokensFreed: number;
  avgDurationMs: number;
  avgThresholdPct: number;
  avgReductionPct: number;
  byTrigger: { reason: string; count: number }[];
  byLayer: { layer: string; count: number }[];
}

export interface InferenceRecord {
  id: string;
  sessionId: string;
  agentId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  latencyMs: number;
  stopReason: string;
  messageCount: number;
  toolDefCount: number;
  systemBlockCount: number;
  hasImages: boolean;
  requestSystem: string | null;
  requestMessages: string | null;
  requestTools: string | null;
  responseContent: string | null;
  providerRequest: string | null;
  providerResponse: string | null;
  providerDetail: string | null;
  timestamp: number;
  toolCalls: Array<{ name: string; input: string; output: string; isError: boolean; durationMs: number }>;
  guardDecisions: GuardDecisionRecord[];
}

export interface SessionSummary {
  id: string;
  agentId: string | null;
  startTime: number;
  endTime: number | null;
  totalCost: number;
  status: string;
  llmCallCount: number;
  toolCallCount: number;
  guardDecisionCount: number;
  compactionCount: number;
  eventCount: number;
}

export interface AgentStats {
  agentId: string;
  sessionCount: number;
  totalCost: number;
  llmCallCount: number;
  toolCallCount: number;
  avgCostPerSession: number;
}

export interface CleanupResult {
  removed: number;
}
