// ============================================================
// Berry Agent SDK — Observe: Public API
// ============================================================

// Factory
export { createObserver } from './observer.js';
export type { Observer, ObserverConfig } from './observer.js';

// Analyzer
export { Analyzer } from './analyzer.js';

// Database
export { createDatabase } from './db.js';
export type { ObserveDB } from './db.js';

// Schema
export { sessions, turns, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './schema.js';

// Pricing
export { calculateCost, getPricing, MODEL_PRICING } from './pricing.js';
export type { ModelPricing, CostResult } from './pricing.js';

// Collectors
export { createCollector, createMiddleware, createEventListener } from './collector.js';
export type { CollectorConfig } from './collector.js';

// Retention
export { cleanup } from './retention.js';

// Server (Express Router)
export { createObserveRouter } from './server.js';

// Standalone Server (API + UI)
export { startObserveServer } from './standalone.js';
export type { StandaloneOptions } from './standalone.js';

// Shared API types + paths (single source of truth for server ↔ UI)
// All response interfaces come from here — analyzer re-exports the same types.
export { OBSERVE_API_PATHS } from './api-types.js';
export type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord, GuardByToolStat,
  CompactionRecord, CompactionStats,
  InferenceRecord, TurnSummary, SessionSummary, AgentStats, AgentDetail,
  DimensionFilter, CleanupResult,
} from './api-types.js';
