// ============================================================
// Berry Agent SDK — Observe: Public API
// ============================================================

// Factory
export { createObserver } from './observer.js';
export type { Observer, ObserverConfig } from './observer.js';

// Analyzer
export { Analyzer } from './analyzer/analyzer.js';
export { MetricsCalculator } from './analyzer/metrics.js';

// Database
export { createDatabase } from './collector/db.js';
export type { ObserveDB } from './collector/db.js';

// Schema
export { sessions, turns, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './collector/schema.js';

// Pricing
export { calculateCost, getPricing, MODEL_PRICING } from './collector/pricing.js';
export type { ModelPricing, CostResult } from './collector/pricing.js';
export { fetchOpenRouterPricing } from './collector/openrouter-pricing.js';

// Collectors
export { createCollector } from './collector/collector.js';
export type { CollectorConfig } from './collector/collector.js';

// Retention
export { cleanup } from './collector/retention.js';

// Server (Express Router)
export { createObserveRouter } from './server.js';

// Standalone Server (API + UI)
export { startObserveServer } from './standalone.js';
export type { StandaloneOptions } from './standalone.js';

// Shared API types + paths (single source of truth for server <-> UI)
// All response interfaces come from here — analyzer re-exports the same types.
export { OBSERVE_API_PATHS } from './analyzer/api-types.js';
export type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord, GuardByToolStat,
  CompactionRecord, CompactionStats,
  InferenceRecord, TurnSummary, SessionSummary, AgentStats, AgentDetail,
  DimensionFilter, CleanupResult,
  StabilityMetrics, TurnMetrics, SessionMetrics, AgentMetrics,
} from './analyzer/api-types.js';

// Zod schemas for view-model payloads — exported so server can validate
// outgoing responses and UI can validate fetched payloads at the boundary.
export {
  costBreakdownSchema, costByModelSchema, costTrendPointSchema, cacheEfficiencySchema,
  toolStatSchema, guardStatSchema, guardDecisionRecordSchema, guardByToolStatSchema,
  compactionRecordSchema, compactionStatsSchema,
  inferenceRecordSchema, turnSummarySchema, sessionSummarySchema,
  agentStatsSchema, agentDetailSchema,
  dimensionFilterSchema, cleanupResultSchema,
  stabilityMetricsSchema, turnMetricsSchema, sessionMetricsSchema, agentMetricsSchema,
} from './analyzer/api-types.js';

// Zod schema for SDK config namespace
export { observeNamespaceSchema } from './schema.js';
export type { ObserveNamespaceConfig } from './schema.js';
