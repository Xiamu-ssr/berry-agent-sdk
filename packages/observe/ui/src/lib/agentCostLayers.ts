// ============================================================
// Observe UI — consumption layering helpers (by-agent)
// ============================================================
//
// Pure, framework-free aggregation used by AgentDashboard to turn the flat
// `/agents` payload into a *layered* cost view: agents ranked by spend, each
// with its share of the cluster total, plus a roll-up summary. Kept pure so
// it is unit-testable without React.

/** Minimal shape we need from the observe `/agents` (agentStatsSchema) rows. */
export interface AgentCostRow {
  agentId: string;
  sessionCount: number;
  totalCost: number;
  llmCallCount: number;
  toolCallCount: number;
  avgCostPerSession: number;
}

export interface RankedAgentCost extends AgentCostRow {
  /** Share of the cluster-wide total cost, in [0, 1]. 0 when the total is 0. */
  share: number;
  /** 1-based rank by total cost (1 = most expensive). */
  rank: number;
}

export interface AgentCostLayers {
  agents: RankedAgentCost[];
  totalCost: number;
  agentCount: number;
  /** The single most expensive agent, or null when there are no agents. */
  topSpender: RankedAgentCost | null;
}

/**
 * Rank agents by total cost (desc) and attach each agent's share of the
 * cluster total. Ties are broken by agentId for a stable order. Negative or
 * non-finite costs are clamped to 0 so the layering never produces NaN/odd
 * bars from bad upstream data.
 */
export function rankAgentsByCost(rows: readonly AgentCostRow[]): AgentCostLayers {
  const safe = rows.map((r) => ({
    ...r,
    totalCost: Number.isFinite(r.totalCost) && r.totalCost > 0 ? r.totalCost : 0,
  }));

  const totalCost = safe.reduce((sum, r) => sum + r.totalCost, 0);

  const sorted = [...safe].sort((a, b) => {
    if (b.totalCost !== a.totalCost) return b.totalCost - a.totalCost;
    return a.agentId.localeCompare(b.agentId);
  });

  const agents: RankedAgentCost[] = sorted.map((r, i) => ({
    ...r,
    share: totalCost > 0 ? r.totalCost / totalCost : 0,
    rank: i + 1,
  }));

  return {
    agents,
    totalCost,
    agentCount: agents.length,
    topSpender: agents[0] ?? null,
  };
}

/** Format a [0,1] share as a percent string, e.g. 0.1234 -> "12.3%". */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  return `${(share * 100).toFixed(1)}%`;
}
