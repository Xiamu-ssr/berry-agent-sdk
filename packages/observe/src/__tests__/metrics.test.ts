import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../collector/db.js';
import { Analyzer } from '../analyzer/analyzer.js';
import { MetricsCalculator } from '../analyzer/metrics.js';
import { sessions, turns, llmCalls, toolCalls, guardDecisions, compactionEvents } from '../collector/schema.js';
import type { ObserveDB } from '../collector/db.js';

// ===== Helpers =====

function seedSession(db: ObserveDB, id: string, agentId?: string) {
  db.db.insert(sessions).values({
    id,
    agentId: agentId ?? null,
    startTime: Date.now() - 120_000,
    endTime: Date.now(),
    totalCost: 0.05,
    status: 'completed',
  }).run();
}

function seedTurn(db: ObserveDB, id: string, sessionId: string, opts?: { agentId?: string; startTime?: number; endTime?: number; llmCallCount?: number; toolCallCount?: number }) {
  db.db.insert(turns).values({
    id,
    sessionId,
    agentId: opts?.agentId ?? null,
    prompt: 'test prompt',
    startTime: opts?.startTime ?? Date.now() - 60_000,
    endTime: opts?.endTime ?? Date.now(),
    llmCallCount: opts?.llmCallCount ?? 0,
    toolCallCount: opts?.toolCallCount ?? 0,
    totalCost: 0,
    status: 'completed',
  }).run();
}

function seedLlmCall(db: ObserveDB, id: string, sessionId: string, opts?: { turnId?: string; agentId?: string; model?: string; inputTokens?: number; outputTokens?: number }) {
  db.db.insert(llmCalls).values({
    id,
    sessionId,
    agentId: opts?.agentId ?? null,
    turnId: opts?.turnId ?? null,
    provider: 'anthropic',
    model: opts?.model ?? 'claude-sonnet-4-20250514',
    inputTokens: opts?.inputTokens ?? 1000,
    outputTokens: opts?.outputTokens ?? 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 50,
    inputCost: 0.003,
    outputCost: 0.0075,
    cacheSavings: 0.00054,
    totalCost: 0.011,
    latencyMs: 500,
    ttftMs: 100,
    stopReason: 'end_turn',
    messageCount: 2,
    toolDefCount: 1,
    systemBlockCount: 1,
    hasImages: false,
    skillsLoaded: null,
    providerDetail: null,
    timestamp: Date.now(),
  }).run();
}

function seedToolCall(db: ObserveDB, id: string, sessionId: string, opts?: { turnId?: string; name?: string; isError?: boolean }) {
  db.db.insert(toolCalls).values({
    id,
    sessionId,
    llmCallId: null,
    turnId: opts?.turnId ?? null,
    name: opts?.name ?? 'read_file',
    input: '{}',
    output: 'ok',
    isError: opts?.isError ?? false,
    durationMs: 10,
    timestamp: Date.now(),
  }).run();
}

function seedGuardDecision(db: ObserveDB, id: string, sessionId: string, opts?: { turnId?: string; decision?: string }) {
  db.db.insert(guardDecisions).values({
    id,
    sessionId,
    llmCallId: null,
    turnId: opts?.turnId ?? null,
    toolName: 'read_file',
    input: '{}',
    decision: opts?.decision ?? 'allow',
    reason: null,
    modifiedInput: null,
    callIndex: 1,
    durationMs: 2,
    timestamp: Date.now(),
  }).run();
}

// ===== Tests =====

describe('MetricsCalculator', () => {
  let database: ObserveDB;
  let analyzer: Analyzer;
  let metrics: MetricsCalculator;

  beforeEach(() => {
    database = createDatabase();
    analyzer = new Analyzer(database);
    metrics = new MetricsCalculator(analyzer, database);
  });

  afterEach(() => {
    database.sqlite.close();
  });

  // ----- turnMetrics -----

  it('turnMetrics returns null for unknown turn', () => {
    const result = metrics.turnMetrics('nonexistent');
    expect(result).toBeNull();
  });

  it('turnMetrics computes correct values for a turn with tools and guards', () => {
    seedSession(database, 'ses_1');
    seedTurn(database, 'turn_1', 'ses_1', { startTime: 1000, endTime: 6000, llmCallCount: 2, toolCallCount: 3 });
    seedLlmCall(database, 'llm_1', 'ses_1', { turnId: 'turn_1', inputTokens: 500, outputTokens: 200 });
    seedLlmCall(database, 'llm_2', 'ses_1', { turnId: 'turn_1', inputTokens: 300, outputTokens: 100 });
    seedToolCall(database, 'tc_1', 'ses_1', { turnId: 'turn_1', isError: false });
    seedToolCall(database, 'tc_2', 'ses_1', { turnId: 'turn_1', isError: true });
    seedToolCall(database, 'tc_3', 'ses_1', { turnId: 'turn_1', isError: false });
    seedGuardDecision(database, 'gd_1', 'ses_1', { turnId: 'turn_1', decision: 'allow' });
    seedGuardDecision(database, 'gd_2', 'ses_1', { turnId: 'turn_1', decision: 'deny' });

    const result = metrics.turnMetrics('turn_1');
    expect(result).not.toBeNull();
    expect(result!.turnId).toBe('turn_1');
    // 2/3 tools succeeded
    expect(result!.toolSuccessRate).toBeCloseTo(2 / 3);
    expect(result!.toolCallCount).toBe(3);
    // 1/2 guard decisions were deny
    expect(result!.guardDenyRate).toBeCloseTo(0.5);
    expect(result!.guardDecisionCount).toBe(2);
    expect(result!.totalInputTokens).toBe(800);
    expect(result!.totalOutputTokens).toBe(300);
    expect(result!.durationMs).toBe(5000);
    expect(result!.llmCallCount).toBe(2);
    expect(result!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('turnMetrics handles turn with no tools or guards', () => {
    seedSession(database, 'ses_1');
    seedTurn(database, 'turn_1', 'ses_1');
    seedLlmCall(database, 'llm_1', 'ses_1', { turnId: 'turn_1' });

    const result = metrics.turnMetrics('turn_1');
    expect(result).not.toBeNull();
    expect(result!.toolSuccessRate).toBe(0);
    expect(result!.toolCallCount).toBe(0);
    expect(result!.guardDenyRate).toBe(0);
    expect(result!.guardDecisionCount).toBe(0);
  });

  // ----- sessionMetrics -----

  it('sessionMetrics returns null for unknown session', () => {
    const result = metrics.sessionMetrics('nonexistent');
    expect(result).toBeNull();
  });

  it('sessionMetrics computes correct values for multi-turn session', () => {
    seedSession(database, 'ses_1');
    seedTurn(database, 'turn_1', 'ses_1', { startTime: 1000, endTime: 5000 });
    seedTurn(database, 'turn_2', 'ses_1', { startTime: 6000, endTime: 9000 });
    seedLlmCall(database, 'llm_1', 'ses_1', { turnId: 'turn_1', model: 'claude-sonnet-4-20250514' });
    seedLlmCall(database, 'llm_2', 'ses_1', { turnId: 'turn_2', model: 'gpt-4o' });
    seedToolCall(database, 'tc_1', 'ses_1', { turnId: 'turn_1', name: 'read_file', isError: false });
    seedToolCall(database, 'tc_2', 'ses_1', { turnId: 'turn_1', name: 'write_file', isError: false });
    seedToolCall(database, 'tc_3', 'ses_1', { turnId: 'turn_2', name: 'read_file', isError: true });

    // Add compaction
    database.db.insert(compactionEvents).values({
      id: 'ce_1',
      sessionId: 'ses_1',
      triggerReason: 'threshold',
      contextBefore: 180000,
      contextAfter: 50000,
      thresholdPct: 0.9,
      contextWindow: 200000,
      layersApplied: '["clear_thinking"]',
      durationMs: 1200,
      tokensFreed: 130000,
      timestamp: Date.now(),
    }).run();

    const result = metrics.sessionMetrics('ses_1');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('ses_1');
    expect(result!.turnsCount).toBe(2);
    expect(result!.totalCost).toBeGreaterThan(0);
    expect(result!.totalInputTokens).toBeGreaterThan(0);
    expect(result!.totalOutputTokens).toBeGreaterThan(0);
    expect(result!.toolDistribution).toEqual({ read_file: 2, write_file: 1 });
    expect(result!.modelDistribution['claude-sonnet-4-20250514']).toBe(1);
    expect(result!.modelDistribution['gpt-4o']).toBe(1);
    expect(result!.compactionCount).toBe(1);
    // Both turns have tools: turn_1 has 100% success, turn_2 has 0% success → avg 50%
    expect(result!.avgToolSuccessRate).toBeCloseTo(0.5);
    expect(result!.avgTurnDurationMs).toBeGreaterThan(0);
  });

  it('sessionMetrics handles session with no turns', () => {
    seedSession(database, 'ses_empty');

    const result = metrics.sessionMetrics('ses_empty');
    expect(result).not.toBeNull();
    expect(result!.turnsCount).toBe(0);
    expect(result!.toolDistribution).toEqual({});
    expect(result!.avgToolSuccessRate).toBe(0);
    expect(result!.compactionCount).toBe(0);
  });

  // ----- agentMetrics -----

  it('agentMetrics returns null for unknown agent', () => {
    const result = metrics.agentMetrics('unknown-agent');
    expect(result).toBeNull();
  });

  it('agentMetrics computes correct values for agent with multiple sessions', () => {
    seedSession(database, 'ses_1', 'agent-a');
    seedSession(database, 'ses_2', 'agent-a');
    seedLlmCall(database, 'llm_1', 'ses_1', { agentId: 'agent-a', model: 'claude-sonnet-4-20250514' });
    seedLlmCall(database, 'llm_2', 'ses_2', { agentId: 'agent-a', model: 'gpt-4o' });
    seedLlmCall(database, 'llm_3', 'ses_2', { agentId: 'agent-a', model: 'claude-sonnet-4-20250514' });
    seedToolCall(database, 'tc_1', 'ses_1', { name: 'read_file' });
    seedToolCall(database, 'tc_2', 'ses_1', { name: 'write_file' });
    seedToolCall(database, 'tc_3', 'ses_2', { name: 'read_file' });

    const result = metrics.agentMetrics('agent-a');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('agent-a');
    expect(result!.sessionCount).toBe(2);
    expect(result!.totalCost).toBeGreaterThan(0);
    expect(result!.totalTokens).toBeGreaterThan(0);
    expect(result!.avgSessionCost).toBeCloseTo(result!.totalCost / 2);
    expect(result!.topTools).toEqual([
      { name: 'read_file', count: 2 },
      { name: 'write_file', count: 1 },
    ]);
    expect(result!.modelUsage['claude-sonnet-4-20250514']).toBe(2);
    expect(result!.modelUsage['gpt-4o']).toBe(1);
  });

  it('agentMetrics returns correct avgSessionCost with single session', () => {
    seedSession(database, 'ses_1', 'agent-solo');
    seedLlmCall(database, 'llm_1', 'ses_1', { agentId: 'agent-solo' });

    const result = metrics.agentMetrics('agent-solo');
    expect(result).not.toBeNull();
    expect(result!.sessionCount).toBe(1);
    expect(result!.avgSessionCost).toBe(result!.totalCost);
  });
});
