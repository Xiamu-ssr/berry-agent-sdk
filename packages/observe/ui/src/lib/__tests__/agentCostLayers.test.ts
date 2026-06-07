import { describe, expect, it } from 'vitest';
import { rankAgentsByCost, formatShare, type AgentCostRow } from '../agentCostLayers';

const row = (agentId: string, totalCost: number, over: Partial<AgentCostRow> = {}): AgentCostRow => ({
  agentId,
  sessionCount: 1,
  totalCost,
  llmCallCount: 0,
  toolCallCount: 0,
  avgCostPerSession: totalCost,
  ...over,
});

describe('rankAgentsByCost', () => {
  it('sorts agents by total cost descending and assigns ranks + shares', () => {
    const out = rankAgentsByCost([row('a', 1), row('b', 3), row('c', 6)]);
    expect(out.totalCost).toBe(10);
    expect(out.agentCount).toBe(3);
    expect(out.agents.map((a) => a.agentId)).toEqual(['c', 'b', 'a']);
    expect(out.agents.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(out.agents[0].share).toBeCloseTo(0.6, 5);
    expect(out.agents[1].share).toBeCloseTo(0.3, 5);
    expect(out.agents[2].share).toBeCloseTo(0.1, 5);
    expect(out.topSpender?.agentId).toBe('c');
  });

  it('breaks cost ties by agentId for a stable order', () => {
    const out = rankAgentsByCost([row('zebra', 2), row('alpha', 2)]);
    expect(out.agents.map((a) => a.agentId)).toEqual(['alpha', 'zebra']);
  });

  it('handles an empty list without NaN', () => {
    const out = rankAgentsByCost([]);
    expect(out.totalCost).toBe(0);
    expect(out.agentCount).toBe(0);
    expect(out.topSpender).toBeNull();
    expect(out.agents).toEqual([]);
  });

  it('gives zero shares (not NaN) when every agent has zero cost', () => {
    const out = rankAgentsByCost([row('a', 0), row('b', 0)]);
    expect(out.totalCost).toBe(0);
    expect(out.agents.every((a) => a.share === 0)).toBe(true);
  });

  it('clamps negative / non-finite costs to zero', () => {
    const out = rankAgentsByCost([row('bad', -5), row('nan', Number.NaN), row('ok', 4)]);
    expect(out.totalCost).toBe(4);
    expect(out.agents.find((a) => a.agentId === 'bad')!.totalCost).toBe(0);
    expect(out.agents.find((a) => a.agentId === 'nan')!.totalCost).toBe(0);
    expect(out.topSpender?.agentId).toBe('ok');
    expect(out.topSpender?.share).toBeCloseTo(1, 5);
  });
});

describe('formatShare', () => {
  it('formats a ratio as a one-decimal percent', () => {
    expect(formatShare(0.1234)).toBe('12.3%');
    expect(formatShare(1)).toBe('100.0%');
  });
  it('returns 0% for zero / negative / non-finite', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(-0.2)).toBe('0%');
    expect(formatShare(Number.NaN)).toBe('0%');
  });
});
