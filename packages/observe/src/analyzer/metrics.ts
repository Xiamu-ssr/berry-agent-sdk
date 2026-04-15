// ============================================================
// Berry Agent SDK — Observe: Derived Metrics Calculator
// ============================================================
// Higher-level metrics derived from the raw observe data.
// Wraps the Analyzer to compute success rates, distributions, and costs.

import { eq, sql, and } from 'drizzle-orm';
import type { Analyzer } from './analyzer.js';
import type { ObserveDB } from '../collector/db.js';
import { llmCalls, toolCalls, guardDecisions, turns, sessions, compactionEvents } from '../collector/schema.js';

// ----- Turn Metrics -----

/** Derived metrics for a single turn */
export interface TurnMetrics {
  turnId: string;
  /** Fraction of tool_calls where isError === false (0..1) */
  toolSuccessRate: number;
  toolCallCount: number;
  /** Fraction of guard decisions that were deny (0..1) */
  guardDenyRate: number;
  guardDecisionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Duration from first to last event timestamp (ms) */
  durationMs: number;
  llmCallCount: number;
}

// ----- Session Metrics -----

/** Derived metrics aggregated across all turns in a session */
export interface SessionMetrics {
  sessionId: string;
  turnsCount: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Tool name to call count */
  toolDistribution: Record<string, number>;
  /** Average tool success rate across all turns (0..1) */
  avgToolSuccessRate: number;
  /** Average turn duration in ms */
  avgTurnDurationMs: number;
  compactionCount: number;
  /** Model name to call count */
  modelDistribution: Record<string, number>;
}

// ----- Agent Metrics -----

/** Derived metrics aggregated across all sessions for an agent */
export interface AgentMetrics {
  agentId: string;
  sessionCount: number;
  totalCost: number;
  totalTokens: number;
  avgSessionCost: number;
  /** Top tools by call count (descending) */
  topTools: Array<{ name: string; count: number }>;
  /** Model name to call count */
  modelUsage: Record<string, number>;
}

// ----- Calculator -----

/**
 * Computes higher-level derived metrics from raw observe data.
 * Wraps the existing Analyzer and accesses the database for custom aggregations.
 */
export class MetricsCalculator {
  private db: ObserveDB;

  constructor(private analyzer: Analyzer, db: ObserveDB) {
    this.db = db;
  }

  /** Compute derived metrics for a single turn. Returns null if the turn does not exist. */
  turnMetrics(turnId: string): TurnMetrics | null {
    const summary = this.analyzer.turnSummary(turnId);
    if (!summary) return null;

    // Tool success rate
    const toolRows = this.db.db.select({
      totalCount: sql<number>`count(*)`,
      errorCount: sql<number>`sum(case when ${toolCalls.isError} then 1 else 0 end)`,
    }).from(toolCalls)
      .where(eq(toolCalls.turnId, turnId))
      .get();

    const toolTotal = toolRows?.totalCount ?? 0;
    const toolErrors = toolRows?.errorCount ?? 0;
    const toolSuccessRate = toolTotal > 0 ? (toolTotal - toolErrors) / toolTotal : 0;

    // Guard deny rate
    const guardRows = this.db.db.select({
      totalCount: sql<number>`count(*)`,
      denyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'deny' then 1 else 0 end)`,
    }).from(guardDecisions)
      .where(eq(guardDecisions.turnId, turnId))
      .get();

    const guardTotal = guardRows?.totalCount ?? 0;
    const guardDenies = guardRows?.denyCount ?? 0;
    const guardDenyRate = guardTotal > 0 ? guardDenies / guardTotal : 0;

    // Token totals
    const tokenRow = this.db.db.select({
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`,
    }).from(llmCalls)
      .where(eq(llmCalls.turnId, turnId))
      .get();

    // Duration
    const durationMs = summary.endTime
      ? summary.endTime - summary.startTime
      : 0;

    return {
      turnId,
      toolSuccessRate,
      toolCallCount: toolTotal,
      guardDenyRate,
      guardDecisionCount: guardTotal,
      totalInputTokens: tokenRow?.inputTokens ?? 0,
      totalOutputTokens: tokenRow?.outputTokens ?? 0,
      estimatedCostUsd: summary.cost.totalCost,
      durationMs,
      llmCallCount: summary.llmCallCount,
    };
  }

  /** Compute derived metrics for a session. Returns null if the session does not exist. */
  sessionMetrics(sessionId: string): SessionMetrics | null {
    const sessionRow = this.db.db.select().from(sessions)
      .where(eq(sessions.id, sessionId)).get();
    if (!sessionRow) return null;

    // Turns
    const turnRows = this.db.db.select().from(turns)
      .where(eq(turns.sessionId, sessionId)).all();

    // Aggregate turn-level success rates + durations
    let totalSuccessRate = 0;
    let totalDuration = 0;
    let turnsWithTools = 0;
    let turnsWithDuration = 0;

    for (const turn of turnRows) {
      const tm = this.turnMetrics(turn.id);
      if (tm) {
        if (tm.toolCallCount > 0) {
          totalSuccessRate += tm.toolSuccessRate;
          turnsWithTools++;
        }
        if (tm.durationMs > 0) {
          totalDuration += tm.durationMs;
          turnsWithDuration++;
        }
      }
    }

    // Token totals
    const tokenRow = this.db.db.select({
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`,
    }).from(llmCalls)
      .where(eq(llmCalls.sessionId, sessionId))
      .get();

    // Tool distribution
    const toolDistRows = this.db.db.select({
      name: toolCalls.name,
      count: sql<number>`count(*)`,
    }).from(toolCalls)
      .where(eq(toolCalls.sessionId, sessionId))
      .groupBy(toolCalls.name)
      .all();
    const toolDistribution: Record<string, number> = {};
    for (const r of toolDistRows) {
      toolDistribution[r.name] = r.count;
    }

    // Model distribution
    const modelDistRows = this.db.db.select({
      model: llmCalls.model,
      count: sql<number>`count(*)`,
    }).from(llmCalls)
      .where(eq(llmCalls.sessionId, sessionId))
      .groupBy(llmCalls.model)
      .all();
    const modelDistribution: Record<string, number> = {};
    for (const r of modelDistRows) {
      modelDistribution[r.model] = r.count;
    }

    // Compaction count
    const compactionRow = this.db.db.select({
      count: sql<number>`count(*)`,
    }).from(compactionEvents)
      .where(eq(compactionEvents.sessionId, sessionId))
      .get();

    // Cost
    const cost = this.analyzer.costBreakdown({ sessionId });

    return {
      sessionId,
      turnsCount: turnRows.length,
      totalCost: cost.totalCost,
      totalInputTokens: tokenRow?.inputTokens ?? 0,
      totalOutputTokens: tokenRow?.outputTokens ?? 0,
      toolDistribution,
      avgToolSuccessRate: turnsWithTools > 0 ? totalSuccessRate / turnsWithTools : 0,
      avgTurnDurationMs: turnsWithDuration > 0 ? totalDuration / turnsWithDuration : 0,
      compactionCount: compactionRow?.count ?? 0,
      modelDistribution,
    };
  }

  /** Compute derived metrics for an agent. Returns null if no sessions exist for the agent. */
  agentMetrics(agentId: string): AgentMetrics | null {
    // Session count + cost
    const sessionRow = this.db.db.select({
      sessionCount: sql<number>`count(*)`,
      totalCost: sql<number>`coalesce(sum(${sessions.totalCost}), 0)`,
    }).from(sessions)
      .where(eq(sessions.agentId, agentId))
      .get();

    if (!sessionRow || sessionRow.sessionCount === 0) return null;

    // Token totals
    const tokenRow = this.db.db.select({
      totalTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}) + sum(${llmCalls.outputTokens}), 0)`,
    }).from(llmCalls)
      .where(eq(llmCalls.agentId, agentId))
      .get();

    // Tool distribution (top tools)
    const toolDistRows = this.db.db.select({
      name: toolCalls.name,
      count: sql<number>`count(*)`,
    }).from(toolCalls)
      .where(sql`${toolCalls.sessionId} IN (
        SELECT id FROM sessions WHERE agent_id = ${agentId}
      )`)
      .groupBy(toolCalls.name)
      .orderBy(sql`count(*) DESC`)
      .limit(10)
      .all();

    const topTools = toolDistRows.map(r => ({ name: r.name, count: r.count }));

    // Model usage
    const modelRows = this.db.db.select({
      model: llmCalls.model,
      count: sql<number>`count(*)`,
    }).from(llmCalls)
      .where(eq(llmCalls.agentId, agentId))
      .groupBy(llmCalls.model)
      .all();

    const modelUsage: Record<string, number> = {};
    for (const r of modelRows) {
      modelUsage[r.model] = r.count;
    }

    const { sessionCount, totalCost } = sessionRow;
    return {
      agentId,
      sessionCount,
      totalCost,
      totalTokens: tokenRow?.totalTokens ?? 0,
      avgSessionCost: sessionCount > 0 ? totalCost / sessionCount : 0,
      topTools,
      modelUsage,
    };
  }
}
