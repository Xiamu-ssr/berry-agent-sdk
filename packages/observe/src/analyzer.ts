// ============================================================
// Berry Agent SDK — Observe: Analyzers
// ============================================================

import { eq, sql, desc, gte, and } from 'drizzle-orm';
import type { ObserveDB } from './db.js';
import { sessions, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from './schema.js';

// Re-export all API types from shared definition (single source of truth).
export type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord,
  CompactionRecord, CompactionStats,
  InferenceRecord, SessionSummary, AgentStats,
} from './api-types.js';

import type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord,
  CompactionRecord, CompactionStats,
  InferenceRecord, SessionSummary, AgentStats,
} from './api-types.js';

// ===== Analyzer =====

export class Analyzer {
  constructor(private db: ObserveDB) {}

  // ===== Cost Analysis =====

  costBreakdown(sessionId?: string): CostBreakdown {
    const where = sessionId ? eq(llmCalls.sessionId, sessionId) : undefined;
    const base = this.db.db.select({
      inputCost: sql<number>`coalesce(sum(${llmCalls.inputCost}), 0)`,
      outputCost: sql<number>`coalesce(sum(${llmCalls.outputCost}), 0)`,
      cacheSavings: sql<number>`coalesce(sum(${llmCalls.cacheSavings}), 0)`,
      totalCost: sql<number>`coalesce(sum(${llmCalls.totalCost}), 0)`,
      callCount: sql<number>`count(*)`,
    }).from(llmCalls);
    const row = where ? base.where(where).get() : base.get();
    return {
      inputCost: row?.inputCost ?? 0,
      outputCost: row?.outputCost ?? 0,
      cacheSavings: row?.cacheSavings ?? 0,
      totalCost: row?.totalCost ?? 0,
      callCount: row?.callCount ?? 0,
    };
  }

  costByModel(): CostByModel[] {
    return this.db.db.select({
      model: llmCalls.model,
      totalCost: sql<number>`coalesce(sum(${llmCalls.totalCost}), 0)`,
      callCount: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${llmCalls.outputTokens}), 0)`,
    }).from(llmCalls)
      .groupBy(llmCalls.model)
      .orderBy(desc(sql`sum(${llmCalls.totalCost})`))
      .all();
  }

  costTrend(days: number = 30): CostTrendPoint[] {
    const since = Date.now() - days * 86_400_000;
    return this.db.db.select({
      date: sql<string>`date(${llmCalls.timestamp} / 1000, 'unixepoch')`,
      totalCost: sql<number>`coalesce(sum(${llmCalls.totalCost}), 0)`,
      callCount: sql<number>`count(*)`,
    }).from(llmCalls)
      .where(gte(llmCalls.timestamp, since))
      .groupBy(sql`date(${llmCalls.timestamp} / 1000, 'unixepoch')`)
      .orderBy(sql`date(${llmCalls.timestamp} / 1000, 'unixepoch')`)
      .all();
  }

  // ===== Cache Analysis =====

  cacheEfficiency(sessionId?: string): CacheEfficiency {
    const where = sessionId ? eq(llmCalls.sessionId, sessionId) : undefined;
    const base = this.db.db.select({
      totalCacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)`,
      totalCacheWriteTokens: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)`,
      totalInputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      totalSavings: sql<number>`coalesce(sum(${llmCalls.cacheSavings}), 0)`,
    }).from(llmCalls);
    const row = where ? base.where(where).get() : base.get();
    const totalInput = row?.totalInputTokens ?? 0;
    const cacheRead = row?.totalCacheReadTokens ?? 0;
    const denominator = totalInput + cacheRead;
    return {
      totalCacheReadTokens: cacheRead,
      totalCacheWriteTokens: row?.totalCacheWriteTokens ?? 0,
      totalInputTokens: totalInput,
      cacheHitRate: denominator > 0 ? cacheRead / denominator : 0,
      totalSavings: row?.totalSavings ?? 0,
    };
  }

  // ===== Tool Analysis =====

  toolStats(sessionId?: string): ToolStat[] {
    const where = sessionId ? eq(toolCalls.sessionId, sessionId) : undefined;
    const base = this.db.db.select({
      name: toolCalls.name,
      callCount: sql<number>`count(*)`,
      errorCount: sql<number>`sum(case when ${toolCalls.isError} then 1 else 0 end)`,
      avgDurationMs: sql<number>`avg(${toolCalls.durationMs})`,
      totalDurationMs: sql<number>`sum(${toolCalls.durationMs})`,
    }).from(toolCalls);
    return (where ? base.where(where) : base)
      .groupBy(toolCalls.name)
      .orderBy(desc(sql`count(*)`))
      .all();
  }

  // ===== Guard Analysis (NEW) =====

  guardStats(sessionId?: string): GuardStat {
    const where = sessionId ? eq(guardDecisions.sessionId, sessionId) : undefined;
    const base = this.db.db.select({
      allowCount: sql<number>`sum(case when ${guardDecisions.decision} = 'allow' then 1 else 0 end)`,
      denyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'deny' then 1 else 0 end)`,
      modifyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'modify' then 1 else 0 end)`,
      avgDurationMs: sql<number>`coalesce(avg(${guardDecisions.durationMs}), 0)`,
    }).from(guardDecisions);
    const row = where ? base.where(where).get() : base.get();
    return {
      allowCount: row?.allowCount ?? 0,
      denyCount: row?.denyCount ?? 0,
      modifyCount: row?.modifyCount ?? 0,
      avgDurationMs: row?.avgDurationMs ?? 0,
    };
  }

  /** List guard decisions, optionally filtered by session or llmCall */
  guardDecisionList(opts?: { sessionId?: string; llmCallId?: string; limit?: number }): GuardDecisionRecord[] {
    let query = this.db.db.select().from(guardDecisions);
    if (opts?.sessionId && opts?.llmCallId) {
      query = query.where(and(
        eq(guardDecisions.sessionId, opts.sessionId),
        eq(guardDecisions.llmCallId, opts.llmCallId),
      )) as any;
    } else if (opts?.sessionId) {
      query = query.where(eq(guardDecisions.sessionId, opts.sessionId)) as any;
    } else if (opts?.llmCallId) {
      query = query.where(eq(guardDecisions.llmCallId, opts.llmCallId)) as any;
    }
    return (query as any).orderBy(desc(guardDecisions.timestamp)).limit(opts?.limit ?? 100).all();
  }

  // ===== Compaction Analysis (NEW) =====

  compactionStats(sessionId?: string): CompactionStats {
    const where = sessionId ? eq(compactionEvents.sessionId, sessionId) : undefined;
    const base = this.db.db.select({
      totalCount: sql<number>`count(*)`,
      avgTokensFreed: sql<number>`coalesce(avg(${compactionEvents.tokensFreed}), 0)`,
      avgDurationMs: sql<number>`coalesce(avg(${compactionEvents.durationMs}), 0)`,
      avgThresholdPct: sql<number>`coalesce(avg(${compactionEvents.thresholdPct}), 0)`,
      avgReductionPct: sql<number>`coalesce(avg(
        case when ${compactionEvents.contextBefore} > 0
          then cast((${compactionEvents.contextBefore} - ${compactionEvents.contextAfter}) as real) / ${compactionEvents.contextBefore}
          else 0
        end
      ), 0)`,
    }).from(compactionEvents);
    const row = where ? base.where(where).get() : base.get();

    // By trigger reason
    const byTriggerBase = this.db.db.select({
      reason: compactionEvents.triggerReason,
      count: sql<number>`count(*)`,
    }).from(compactionEvents);
    const byTrigger = (where ? byTriggerBase.where(where) : byTriggerBase)
      .groupBy(compactionEvents.triggerReason).all();

    // By layer frequency — parse JSON arrays
    const allRecords = this.compactionList({ sessionId, limit: 10000 });
    const layerCounts = new Map<string, number>();
    for (const rec of allRecords) {
      try {
        const layers: string[] = JSON.parse(rec.layersApplied);
        for (const l of layers) layerCounts.set(l, (layerCounts.get(l) ?? 0) + 1);
      } catch { /* skip */ }
    }
    const byLayer = [...layerCounts.entries()]
      .map(([layer, count]) => ({ layer, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalCount: row?.totalCount ?? 0,
      avgTokensFreed: row?.avgTokensFreed ?? 0,
      avgDurationMs: row?.avgDurationMs ?? 0,
      avgThresholdPct: row?.avgThresholdPct ?? 0,
      avgReductionPct: row?.avgReductionPct ?? 0,
      byTrigger,
      byLayer,
    };
  }

  compactionList(opts?: { sessionId?: string; limit?: number }): CompactionRecord[] {
    let query = this.db.db.select().from(compactionEvents);
    if (opts?.sessionId) {
      query = query.where(eq(compactionEvents.sessionId, opts.sessionId)) as any;
    }
    return (query as any).orderBy(desc(compactionEvents.timestamp)).limit(opts?.limit ?? 100).all();
  }

  // ===== Inference Records (NEW) =====

  /** Get a single inference record with associated tools and guard decisions */
  inferenceDetail(llmCallId: string): InferenceRecord | null {
    const call = this.db.db.select().from(llmCalls)
      .where(eq(llmCalls.id, llmCallId)).get();
    if (!call) return null;

    const tools = this.db.db.select({
      name: toolCalls.name,
      input: toolCalls.input,
      output: toolCalls.output,
      isError: toolCalls.isError,
      durationMs: toolCalls.durationMs,
    }).from(toolCalls)
      .where(eq(toolCalls.llmCallId, llmCallId))
      .orderBy(toolCalls.timestamp)
      .all();

    const guards = this.db.db.select().from(guardDecisions)
      .where(eq(guardDecisions.llmCallId, llmCallId))
      .orderBy(guardDecisions.timestamp)
      .all();

    return {
      ...call,
      toolCalls: tools,
      guardDecisions: guards,
    };
  }

  /** List inference records for a session */
  inferenceList(opts?: { sessionId?: string; agentId?: string; limit?: number }): Array<Omit<InferenceRecord, 'toolCalls' | 'guardDecisions' | 'requestMessages' | 'requestSystem' | 'requestTools' | 'responseContent' | 'providerRequest' | 'providerResponse'>> {
    let query = this.db.db.select({
      id: llmCalls.id,
      sessionId: llmCalls.sessionId,
      agentId: llmCalls.agentId,
      provider: llmCalls.provider,
      model: llmCalls.model,
      inputTokens: llmCalls.inputTokens,
      outputTokens: llmCalls.outputTokens,
      cacheReadTokens: llmCalls.cacheReadTokens,
      cacheWriteTokens: llmCalls.cacheWriteTokens,
      totalCost: llmCalls.totalCost,
      latencyMs: llmCalls.latencyMs,
      stopReason: llmCalls.stopReason,
      messageCount: llmCalls.messageCount,
      toolDefCount: llmCalls.toolDefCount,
      systemBlockCount: llmCalls.systemBlockCount,
      hasImages: llmCalls.hasImages,
      providerDetail: llmCalls.providerDetail,
      timestamp: llmCalls.timestamp,
    }).from(llmCalls);

    if (opts?.sessionId && opts?.agentId) {
      query = query.where(and(
        eq(llmCalls.sessionId, opts.sessionId),
        eq(llmCalls.agentId, opts.agentId),
      )) as any;
    } else if (opts?.sessionId) {
      query = query.where(eq(llmCalls.sessionId, opts.sessionId)) as any;
    } else if (opts?.agentId) {
      query = query.where(eq(llmCalls.agentId, opts.agentId)) as any;
    }

    return (query as any).orderBy(desc(llmCalls.timestamp)).limit(opts?.limit ?? 50).all();
  }

  // ===== Session Analysis =====

  sessionSummary(sessionId: string): SessionSummary | null {
    const session = this.db.db.select().from(sessions)
      .where(eq(sessions.id, sessionId)).get();
    if (!session) return null;

    const llmCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(llmCalls).where(eq(llmCalls.sessionId, sessionId)).get();
    const toolCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(toolCalls).where(eq(toolCalls.sessionId, sessionId)).get();
    const guardCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(guardDecisions).where(eq(guardDecisions.sessionId, sessionId)).get();
    const compactCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(compactionEvents).where(eq(compactionEvents.sessionId, sessionId)).get();
    const eventCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(agentEvents).where(eq(agentEvents.sessionId, sessionId)).get();

    return {
      id: session.id,
      agentId: session.agentId,
      startTime: session.startTime,
      endTime: session.endTime,
      totalCost: session.totalCost,
      status: session.status,
      llmCallCount: llmCount?.count ?? 0,
      toolCallCount: toolCount?.count ?? 0,
      guardDecisionCount: guardCount?.count ?? 0,
      compactionCount: compactCount?.count ?? 0,
      eventCount: eventCount?.count ?? 0,
    };
  }

  recentSessions(limit: number = 20): SessionSummary[] {
    const rows = this.db.db.select().from(sessions)
      .orderBy(desc(sessions.startTime))
      .limit(limit)
      .all();

    return rows.map(s => {
      const llmCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(llmCalls).where(eq(llmCalls.sessionId, s.id)).get();
      const toolCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(toolCalls).where(eq(toolCalls.sessionId, s.id)).get();
      const guardCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(guardDecisions).where(eq(guardDecisions.sessionId, s.id)).get();
      const compactCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(compactionEvents).where(eq(compactionEvents.sessionId, s.id)).get();
      const eventCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(agentEvents).where(eq(agentEvents.sessionId, s.id)).get();

      return {
        id: s.id,
        agentId: s.agentId,
        startTime: s.startTime,
        endTime: s.endTime,
        totalCost: s.totalCost,
        status: s.status,
        llmCallCount: llmCount?.count ?? 0,
        toolCallCount: toolCount?.count ?? 0,
        guardDecisionCount: guardCount?.count ?? 0,
        compactionCount: compactCount?.count ?? 0,
        eventCount: eventCount?.count ?? 0,
      };
    });
  }

  // ===== Agent Dimension (NEW) =====

  agentStats(): AgentStats[] {
    const rows = this.db.db.select({
      agentId: sql<string>`coalesce(${sessions.agentId}, 'default')`,
      sessionCount: sql<number>`count(distinct ${sessions.id})`,
      totalCost: sql<number>`coalesce(sum(${sessions.totalCost}), 0)`,
    }).from(sessions)
      .groupBy(sessions.agentId)
      .all();

    return rows.map(r => {
      const llmCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(llmCalls)
        .where(r.agentId === 'default'
          ? sql`${llmCalls.agentId} IS NULL`
          : eq(llmCalls.agentId, r.agentId))
        .get();
      const toolCount = this.db.db.select({ count: sql<number>`count(*)` })
        .from(toolCalls)
        .where(sql`${toolCalls.sessionId} IN (
          SELECT id FROM sessions WHERE coalesce(agent_id, 'default') = ${r.agentId}
        )`)
        .get();

      return {
        agentId: r.agentId,
        sessionCount: r.sessionCount,
        totalCost: r.totalCost,
        llmCallCount: llmCount?.count ?? 0,
        toolCallCount: toolCount?.count ?? 0,
        avgCostPerSession: r.sessionCount > 0 ? r.totalCost / r.sessionCount : 0,
      };
    });
  }
}
