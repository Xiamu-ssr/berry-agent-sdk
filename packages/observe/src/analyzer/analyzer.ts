// ============================================================
// Berry Agent SDK — Observe: Analyzers
// ============================================================

import { eq, sql, desc, gte, and } from 'drizzle-orm';
import type { ObserveDB } from '../collector/db.js';
import { sessions, turns, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from '../collector/schema.js';

// Re-export all API types from shared definition (single source of truth).
export type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord, GuardByToolStat,
  CompactionRecord, CompactionStats,
  InferenceRecord, TurnSummary, SessionSummary, AgentStats, AgentDetail,
  DimensionFilter,
} from './api-types.js';

import type {
  CostBreakdown, CostByModel, CostTrendPoint, CacheEfficiency,
  ToolStat, GuardStat, GuardDecisionRecord, GuardByToolStat,
  CompactionRecord, CompactionStats,
  InferenceRecord, TurnSummary, SessionSummary, AgentStats, AgentDetail,
  DimensionFilter,
} from './api-types.js';

// ===== Helpers =====

function buildLlmWhere(filter: DimensionFilter) {
  const conditions = [];
  if (filter.sessionId) conditions.push(eq(llmCalls.sessionId, filter.sessionId));
  if (filter.agentId) conditions.push(eq(llmCalls.agentId, filter.agentId));
  if (filter.turnId) conditions.push(eq(llmCalls.turnId, filter.turnId));
  return conditions.length > 1 ? and(...conditions) : conditions[0];
}

function buildGuardWhere(filter: DimensionFilter) {
  const conditions = [];
  if (filter.sessionId) conditions.push(eq(guardDecisions.sessionId, filter.sessionId));
  if (filter.agentId) {
    // guard_decisions doesn't have agentId directly — join via session
    // Use sub-select approach via SQL for simplicity
    conditions.push(sql`${guardDecisions.sessionId} IN (
      SELECT id FROM sessions WHERE agent_id = ${filter.agentId}
    )`);
  }
  if (filter.turnId) conditions.push(eq(guardDecisions.turnId, filter.turnId));
  return conditions.length > 1 ? and(...conditions) : conditions[0];
}

function buildCompactionWhere(filter: Pick<DimensionFilter, 'sessionId' | 'agentId'>) {
  const conditions = [];
  if (filter.sessionId) conditions.push(eq(compactionEvents.sessionId, filter.sessionId));
  if (filter.agentId) {
    conditions.push(sql`${compactionEvents.sessionId} IN (
      SELECT id FROM sessions WHERE agent_id = ${filter.agentId}
    )`);
  }
  return conditions.length > 1 ? and(...conditions) : conditions[0];
}

// ===== Analyzer =====

export class Analyzer {
  constructor(private db: ObserveDB) {}

  // ===== Cost Analysis =====

  costBreakdown(filter?: string | DimensionFilter): CostBreakdown {
    // Accept either a bare sessionId string (backward compat) or DimensionFilter
    const f: DimensionFilter = typeof filter === 'string' ? { sessionId: filter } : (filter ?? {});
    const where = buildLlmWhere(f);
    const base = this.db.db.select({
      inputCost: sql<number>`coalesce(sum(${llmCalls.inputCost}), 0)`,
      outputCost: sql<number>`coalesce(sum(${llmCalls.outputCost}), 0)`,
      cacheSavings: sql<number>`coalesce(sum(${llmCalls.cacheSavings}), 0)`,
      totalCost: sql<number>`coalesce(sum(${llmCalls.totalCost}), 0)`,
      callCount: sql<number>`count(*)`,
    }).from(llmCalls);
    const row = where ? (base as any).where(where).get() : base.get();
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

  cacheEfficiency(filter?: string | DimensionFilter): CacheEfficiency {
    const f: DimensionFilter = typeof filter === 'string' ? { sessionId: filter } : (filter ?? {});
    const where = buildLlmWhere(f);
    const base = this.db.db.select({
      totalCacheReadTokens: sql<number>`coalesce(sum(${llmCalls.cacheReadTokens}), 0)`,
      totalCacheWriteTokens: sql<number>`coalesce(sum(${llmCalls.cacheWriteTokens}), 0)`,
      totalInputTokens: sql<number>`coalesce(sum(${llmCalls.inputTokens}), 0)`,
      totalSavings: sql<number>`coalesce(sum(${llmCalls.cacheSavings}), 0)`,
    }).from(llmCalls);
    const row = where ? (base as any).where(where).get() : base.get();
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

  toolStats(filter?: string | DimensionFilter): ToolStat[] {
    const f: DimensionFilter = typeof filter === 'string' ? { sessionId: filter } : (filter ?? {});
    const conditions = [];
    if (f.sessionId) conditions.push(eq(toolCalls.sessionId, f.sessionId));
    if (f.turnId) conditions.push(eq(toolCalls.turnId, f.turnId));
    if (f.agentId) {
      conditions.push(sql`${toolCalls.sessionId} IN (
        SELECT id FROM sessions WHERE agent_id = ${f.agentId}
      )`);
    }
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    const base = this.db.db.select({
      name: toolCalls.name,
      callCount: sql<number>`count(*)`,
      errorCount: sql<number>`sum(case when ${toolCalls.isError} then 1 else 0 end)`,
      avgDurationMs: sql<number>`avg(${toolCalls.durationMs})`,
      totalDurationMs: sql<number>`sum(${toolCalls.durationMs})`,
    }).from(toolCalls);
    return ((where ? (base as any).where(where) : base) as any)
      .groupBy(toolCalls.name)
      .orderBy(desc(sql`count(*)`))
      .all();
  }

  // ===== Guard Analysis =====

  guardStats(filter?: string | DimensionFilter): GuardStat {
    const f: DimensionFilter = typeof filter === 'string' ? { sessionId: filter } : (filter ?? {});
    const where = buildGuardWhere(f);
    const base = this.db.db.select({
      allowCount: sql<number>`sum(case when ${guardDecisions.decision} = 'allow' then 1 else 0 end)`,
      denyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'deny' then 1 else 0 end)`,
      modifyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'modify' then 1 else 0 end)`,
      avgDurationMs: sql<number>`coalesce(avg(${guardDecisions.durationMs}), 0)`,
    }).from(guardDecisions);
    const row = where ? (base as any).where(where).get() : base.get();
    return {
      allowCount: row?.allowCount ?? 0,
      denyCount: row?.denyCount ?? 0,
      modifyCount: row?.modifyCount ?? 0,
      avgDurationMs: row?.avgDurationMs ?? 0,
    };
  }

  /** List guard decisions, optionally filtered by session, agent, turn or llmCall */
  guardDecisionList(opts?: { sessionId?: string; agentId?: string; turnId?: string; llmCallId?: string; toolName?: string; limit?: number }): GuardDecisionRecord[] {
    const conditions = [];
    if (opts?.sessionId) conditions.push(eq(guardDecisions.sessionId, opts.sessionId));
    if (opts?.llmCallId) conditions.push(eq(guardDecisions.llmCallId, opts.llmCallId));
    if (opts?.turnId) conditions.push(eq(guardDecisions.turnId, opts.turnId));
    if (opts?.toolName) conditions.push(eq(guardDecisions.toolName, opts.toolName));
    if (opts?.agentId) {
      conditions.push(sql`${guardDecisions.sessionId} IN (
        SELECT id FROM sessions WHERE agent_id = ${opts.agentId}
      )`);
    }
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    let query = this.db.db.select().from(guardDecisions);
    if (where) query = (query as any).where(where);
    return (query as any).orderBy(desc(guardDecisions.timestamp)).limit(opts?.limit ?? 100).all();
  }

  /** Guard decisions grouped by tool name */
  guardStatsByTool(filter?: DimensionFilter): GuardByToolStat[] {
    const f = filter ?? {};
    const where = buildGuardWhere(f);
    const base = this.db.db.select({
      toolName: guardDecisions.toolName,
      allowCount: sql<number>`sum(case when ${guardDecisions.decision} = 'allow' then 1 else 0 end)`,
      denyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'deny' then 1 else 0 end)`,
      modifyCount: sql<number>`sum(case when ${guardDecisions.decision} = 'modify' then 1 else 0 end)`,
      totalCount: sql<number>`count(*)`,
    }).from(guardDecisions);
    const rows = ((where ? (base as any).where(where) : base) as any)
      .groupBy(guardDecisions.toolName)
      .orderBy(desc(sql`count(*)`))
      .all();
    return rows.map((r: any) => ({
      toolName: r.toolName,
      allowCount: r.allowCount ?? 0,
      denyCount: r.denyCount ?? 0,
      modifyCount: r.modifyCount ?? 0,
      totalCount: r.totalCount ?? 0,
      denyRate: r.totalCount > 0 ? (r.denyCount ?? 0) / r.totalCount : 0,
    }));
  }

  // ===== Compaction Analysis =====

  compactionStats(filter?: string | DimensionFilter): CompactionStats {
    const f: DimensionFilter = typeof filter === 'string' ? { sessionId: filter } : (filter ?? {});
    const where = buildCompactionWhere(f);
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
    const row = where ? (base as any).where(where).get() : base.get();

    // By trigger reason
    const byTriggerBase = this.db.db.select({
      reason: compactionEvents.triggerReason,
      count: sql<number>`count(*)`,
    }).from(compactionEvents);
    const byTrigger = ((where ? (byTriggerBase as any).where(where) : byTriggerBase) as any)
      .groupBy(compactionEvents.triggerReason).all();

    // By layer frequency — parse JSON arrays
    const allRecords = this.compactionList({ sessionId: f.sessionId, agentId: f.agentId, limit: 10000 });
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

  compactionList(opts?: { sessionId?: string; agentId?: string; limit?: number }): CompactionRecord[] {
    const where = buildCompactionWhere({ sessionId: opts?.sessionId, agentId: opts?.agentId });
    let query = this.db.db.select().from(compactionEvents);
    if (where) query = (query as any).where(where);
    return (query as any).orderBy(desc(compactionEvents.timestamp)).limit(opts?.limit ?? 100).all();
  }

  // ===== Turn Analysis (NEW) =====

  turnList(filter?: { sessionId?: string; agentId?: string; limit?: number }): Array<{
    id: string; sessionId: string; agentId: string | null; prompt: string | null;
    startTime: number; endTime: number | null; llmCallCount: number; toolCallCount: number;
    totalCost: number; status: string;
  }> {
    const conditions = [];
    if (filter?.sessionId) conditions.push(eq(turns.sessionId, filter.sessionId));
    if (filter?.agentId) conditions.push(eq(turns.agentId, filter.agentId));
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    let query = this.db.db.select().from(turns);
    if (where) query = (query as any).where(where);
    return (query as any).orderBy(desc(turns.startTime)).limit(filter?.limit ?? 50).all();
  }

  turnSummary(turnId: string): TurnSummary | null {
    const turn = this.db.db.select().from(turns)
      .where(eq(turns.id, turnId)).get();
    if (!turn) return null;

    const cost = this.costBreakdown({ turnId });
    const cache = this.cacheEfficiency({ turnId });
    const guard = this.guardStats({ turnId });

    return {
      id: turn.id,
      sessionId: turn.sessionId,
      agentId: turn.agentId,
      prompt: turn.prompt,
      startTime: turn.startTime,
      endTime: turn.endTime,
      llmCallCount: turn.llmCallCount,
      toolCallCount: turn.toolCallCount,
      totalCost: turn.totalCost,
      status: turn.status,
      cost,
      cache,
      guard,
    };
  }

  // ===== Inference Records =====

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

  /** List inference records filtered by multiple dimensions */
  inferenceList(opts?: {
    sessionId?: string;
    agentId?: string;
    turnId?: string;
    model?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Array<Omit<InferenceRecord, 'toolCalls' | 'guardDecisions' | 'requestMessages' | 'requestSystem' | 'requestTools' | 'responseContent' | 'providerRequest' | 'providerResponse'>> {
    const conditions = [];
    if (opts?.sessionId) conditions.push(eq(llmCalls.sessionId, opts.sessionId));
    if (opts?.agentId) conditions.push(eq(llmCalls.agentId, opts.agentId));
    if (opts?.turnId) conditions.push(eq(llmCalls.turnId, opts.turnId));
    if (opts?.model) conditions.push(eq(llmCalls.model, opts.model));
    if (opts?.since) conditions.push(gte(llmCalls.timestamp, opts.since));
    if (opts?.until) conditions.push(sql`${llmCalls.timestamp} <= ${opts.until}`);
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];

    let query = this.db.db.select({
      id: llmCalls.id,
      sessionId: llmCalls.sessionId,
      agentId: llmCalls.agentId,
      turnId: llmCalls.turnId,
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

    if (where) query = (query as any).where(where);
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

  recentSessions(limit: number = 20, agentId?: string): SessionSummary[] {
    let query = this.db.db.select().from(sessions);
    if (agentId) query = (query as any).where(eq(sessions.agentId, agentId));
    const rows = (query as any).orderBy(desc(sessions.startTime)).limit(limit).all();

    return rows.map((s: any) => {
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

  // ===== Agent Dimension =====

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

  /** Get detailed agent info including aggregated stats and recent sessions */
  agentDetail(agentId: string): AgentDetail | null {
    // Get basic stats
    const sessionRows = this.db.db.select({
      sessionCount: sql<number>`count(*)`,
      totalCost: sql<number>`coalesce(sum(${sessions.totalCost}), 0)`,
    }).from(sessions)
      .where(eq(sessions.agentId, agentId))
      .get();

    if (!sessionRows || sessionRows.sessionCount === 0) return null;

    const llmCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(llmCalls)
      .where(eq(llmCalls.agentId, agentId))
      .get();
    const toolCount = this.db.db.select({ count: sql<number>`count(*)` })
      .from(toolCalls)
      .where(sql`${toolCalls.sessionId} IN (
        SELECT id FROM sessions WHERE agent_id = ${agentId}
      )`)
      .get();

    const llmCallCount = llmCount?.count ?? 0;
    const toolCallCount = toolCount?.count ?? 0;
    const sessionCount = sessionRows.sessionCount;
    const totalCost = sessionRows.totalCost;

    const cost = this.costBreakdown({ agentId });
    const cache = this.cacheEfficiency({ agentId });
    const guard = this.guardStats({ agentId });
    const recentSessions = this.recentSessions(10, agentId);

    return {
      agentId,
      sessionCount,
      totalCost,
      llmCallCount,
      toolCallCount,
      avgCostPerSession: sessionCount > 0 ? totalCost / sessionCount : 0,
      cost,
      cache,
      guard,
      recentSessions,
    };
  }
}
