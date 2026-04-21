// ============================================================
// Berry Agent SDK — Observe: Public API
// ============================================================

// Factory
export { createObserver } from './observer.js';
export type { Observer, ObserverConfig } from './observer.js';

// Analyzer
export { Analyzer } from './analyzer/analyzer.js';
export { MetricsCalculator } from './analyzer/metrics.js';
export type { TurnMetrics, SessionMetrics, AgentMetrics } from './analyzer/metrics.js';

// Database
export { createDatabase } from './collector/db.js';
export type { ObserveDB } from './collector/db.js';

// Schema
export { sessions, turns, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './collector/schema.js';

// Pricing
export { calculateCost, getPricing, MODEL_PRICING } from './collector/pricing.js';
export type { ModelPricing, CostResult } from './collector/pricing.js';

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
} from './analyzer/api-types.js';
