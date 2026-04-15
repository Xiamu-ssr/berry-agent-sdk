// ============================================================
// Berry Agent SDK — Observe: Factory
// ============================================================

import type { Middleware, AgentEvent } from '@berry-agent/core';
import { createDatabase, type ObserveDB } from './db.js';
import { createCollector } from './collector.js';
import { Analyzer } from './analyzer.js';
import { cleanup } from './retention.js';
import type { ModelPricing } from './pricing.js';

export interface ObserverConfig {
  /** Path to SQLite database file. Defaults to ':memory:'. */
  dbPath?: string;
  /** Model pricing overrides. */
  pricingOverrides?: Record<string, ModelPricing>;
  /** Retention days for cleanup (default: 30). */
  retentionDays?: number;
  /** Agent ID for multi-agent setups. */
  agentId?: string;
  /** Whether to store full request/response bodies (default: true). */
  storeFullContent?: boolean;
}

export interface Observer {
  /** Middleware to register on the agent. */
  middleware: Middleware;
  /** Event handler to register on the agent. */
  onEvent: (event: AgentEvent) => void;
  /** Analyzer for querying collected data. */
  analyzer: Analyzer;
  /** Run retention cleanup. Returns number of sessions removed. */
  cleanup: () => number;
  /** Close database connection. */
  close: () => void;
  /** Access to the underlying database (for advanced use). */
  db: ObserveDB;
}

/**
 * Create an observer that tracks LLM calls, tool calls, and agent events.
 *
 * Usage:
 * ```ts
 * const observer = createObserver({ dbPath: './observe.db' });
 * const agent = new Agent({
 *   ...config,
 *   middleware: [observer.middleware],
 *   onEvent: observer.onEvent,
 * });
 * ```
 */
export function createObserver(config: ObserverConfig = {}): Observer {
  const { dbPath, pricingOverrides, retentionDays = 30 } = config;
  const database = createDatabase(dbPath);
  const collectorConfig = {
    db: database,
    pricingOverrides,
    agentId: config.agentId,
    storeFullContent: config.storeFullContent,
  };

  const { middleware, eventListener: onEvent } = createCollector(collectorConfig);
  const analyzer = new Analyzer(database);

  return {
    middleware,
    onEvent,
    analyzer,
    cleanup: () => cleanup(database, retentionDays),
    close: () => database.sqlite.close(),
    db: database,
  };
}
