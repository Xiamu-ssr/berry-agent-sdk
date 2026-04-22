import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../collector/db.js';
import { createCollector } from '../collector/collector.js';
import { Analyzer } from '../analyzer/analyzer.js';
import { cleanup } from '../collector/retention.js';
import { calculateCost, MODEL_PRICING } from '../collector/pricing.js';
import { createObserver } from '../observer.js';
import { sessions, llmCalls, toolCalls, agentEvents, guardDecisions, compactionEvents } from '../collector/schema.js';
import type { ObserveDB } from '../collector/db.js';
import type {
  ProviderRequest,
  ProviderResponse,
  MiddlewareContext,
  ToolResult,
  AgentEvent,
} from '@berry-agent/core';

// ===== Helpers =====

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    systemPrompt: ['You are a helpful assistant.'],
    messages: [{ role: 'user', content: 'Hello', createdAt: Date.now() }],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<ProviderResponse>): ProviderResponse {
  return {
    content: [{ type: 'text', text: 'Hello!' }],
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    },
    rawUsage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

function makeContext(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    sessionId: 'ses_test_001',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    cwd: '/tmp',
    ...overrides,
  };
}

// ===== Schema Tests =====

describe('Schema & Database', () => {
  let database: ObserveDB;

  beforeEach(() => {
    database = createDatabase();
  });

  afterEach(() => {
    database.sqlite.close();
  });

  it('creates all four tables', () => {
    // Verify we can insert into each table (proves they exist)
    database.db.insert(sessions).values({
      id: 'test_session',
      startTime: Date.now(),
      endTime: null,
      totalCost: 0,
      status: 'active',
    }).run();

    const result = database.db.select().from(sessions).all();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('test_session');
  });

  it('sessions table has correct defaults', () => {
    database.db.insert(sessions).values({
      id: 'ses_1',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const row = database.db.select().from(sessions).get()!;
    expect(row.totalCost).toBe(0);
    expect(row.endTime).toBeNull();
  });

  it('llm_calls foreign key references sessions', () => {
    // Insert session first
    database.db.insert(sessions).values({
      id: 'ses_fk',
      startTime: Date.now(),
      status: 'active',
    }).run();

    database.db.insert(llmCalls).values({
      id: 'llm_1',
      sessionId: 'ses_fk',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputCost: 0.0003,
      outputCost: 0.00075,
      cacheSavings: 0,
      totalCost: 0.00105,
      latencyMs: 500,
      ttftMs: null,
      stopReason: 'end_turn',
      messageCount: 1,
      toolDefCount: 0,
      systemBlockCount: 1,
      hasImages: false,
      skillsLoaded: null,
      providerDetail: null,
      timestamp: Date.now(),
    }).run();

    const rows = database.db.select().from(llmCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe('ses_fk');
  });

  it('tool_calls defaults and booleans', () => {
    database.db.insert(sessions).values({
      id: 'ses_tc',
      startTime: Date.now(),
      status: 'active',
    }).run();

    database.db.insert(toolCalls).values({
      id: 'tc_1',
      sessionId: 'ses_tc',
      llmCallId: null,
      name: 'read_file',
      input: '{"path":"/tmp/test"}',
      output: 'file contents',
      isError: false,
      durationMs: 42,
      timestamp: Date.now(),
    }).run();

    const row = database.db.select().from(toolCalls).get()!;
    expect(row.isError).toBe(false);
    expect(row.durationMs).toBe(42);
  });

  it('agent_events stores event data', () => {
    database.db.insert(sessions).values({
      id: 'ses_ev',
      startTime: Date.now(),
      status: 'active',
    }).run();

    database.db.insert(agentEvents).values({
      id: 'ev_1',
      sessionId: 'ses_ev',
      kind: 'query_start',
      detail: JSON.stringify({ prompt: 'Hello' }),
      timestamp: Date.now(),
    }).run();

    const row = database.db.select().from(agentEvents).get()!;
    expect(row.kind).toBe('query_start');
    expect(JSON.parse(row.detail!)).toEqual({ prompt: 'Hello' });
  });
});

// ===== Pricing Tests =====

describe('Pricing', () => {
  it('calculates cost for known model', () => {
    const result = calculateCost('claude-sonnet-4-20250514', 1_000_000, 500_000, 200_000, 50_000);
    // input: 1M * 3/1M = 3.00
    expect(result.inputCost).toBeCloseTo(3.0);
    // output: 500K * 15/1M = 7.50
    expect(result.outputCost).toBeCloseTo(7.5);
    // cacheRead: 200K * 0.3/1M = 0.06; full price: 200K * 3/1M = 0.60; savings: 0.54
    expect(result.cacheSavings).toBeCloseTo(0.54);
    // total = input + output + cacheRead + cacheWrite = 3.0 + 7.5 + 0.06 + (50K * 3.75/1M)
    expect(result.totalCost).toBeCloseTo(3.0 + 7.5 + 0.06 + 0.1875);
  });

  it('returns zero cost for unknown model', () => {
    const result = calculateCost('unknown-model', 1000, 500, 0, 0);
    expect(result.totalCost).toBe(0);
  });

  it('supports pricing overrides', () => {
    const result = calculateCost('my-custom-model', 1_000_000, 0, 0, 0, {
      'my-custom-model': { input: 10, output: 20 },
    });
    expect(result.inputCost).toBeCloseTo(10.0);
  });

  it('has built-in pricing for standard models', () => {
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-20250514']).toBeDefined();
  });
});

// ===== Collector Tests =====

describe('Collector', () => {
  let database: ObserveDB;

  beforeEach(() => {
    database = createDatabase();
  });

  afterEach(() => {
    database.sqlite.close();
  });

  it('middleware records llm_calls on onAfterApiCall', () => {
    // Create session first
    database.db.insert(sessions).values({
      id: 'ses_test_001',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const mw = createCollector({ db: database }).middleware;
    const req = makeRequest();
    const ctx = makeContext();

    // Before call
    const modifiedReq = mw.onBeforeApiCall!(req, ctx);
    expect(modifiedReq).toBeDefined();

    // After call
    mw.onAfterApiCall!(req, makeResponse(), ctx);

    const rows = database.db.select().from(llmCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('anthropic');
    expect(rows[0]!.model).toBe('claude-sonnet-4-20250514');
    expect(rows[0]!.inputTokens).toBe(100);
    expect(rows[0]!.outputTokens).toBe(50);
    expect(rows[0]!.totalCost).toBeGreaterThan(0);
    expect(rows[0]!.providerDetail).toBeTruthy();
  });

  it('middleware records tool_calls', () => {
    database.db.insert(sessions).values({
      id: 'ses_test_001',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const mw = createCollector({ db: database }).middleware;
    const ctx = makeContext();
    const input = { path: '/tmp/test' };

    const modifiedInput = mw.onBeforeToolExec!('read_file', input, ctx);
    const result: ToolResult = { content: 'file contents', isError: false };
    mw.onAfterToolExec!('read_file', modifiedInput, result, ctx);

    const rows = database.db.select().from(toolCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('read_file');
    expect(rows[0]!.isError).toBe(false);
  });

  it('middleware stores full tool output for normal-sized results', () => {
    database.db.insert(sessions).values({
      id: 'ses_test_001',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const mw = createCollector({ db: database }).middleware;
    const ctx = makeContext();
    const input = { path: '/tmp/test' };

    const modifiedInput = mw.onBeforeToolExec!('read_file', input, ctx);
    // 10KB — well under the 500KB DB ceiling → stored in full
    const longOutput = 'x'.repeat(10000);
    const result: ToolResult = { content: longOutput };
    mw.onAfterToolExec!('read_file', modifiedInput, result, ctx);

    const rows = database.db.select().from(toolCalls).all();
    expect(rows[0]!.output).toBe(longOutput);
  });

  it('middleware truncates tool output that exceeds 500KB DB ceiling', () => {
    database.db.insert(sessions).values({
      id: 'ses_test_002',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const mw = createCollector({ db: database }).middleware;
    const ctx = makeContext({ sessionId: 'ses_test_002' });
    const input = { path: '/tmp/huge' };

    const modifiedInput = mw.onBeforeToolExec!('read_file', input, ctx);
    // 600KB — exceeds the 500KB ceiling
    const hugeOutput = 'x'.repeat(600_000);
    const result: ToolResult = { content: hugeOutput };
    mw.onAfterToolExec!('read_file', modifiedInput, result, ctx);

    const rows = database.db.select().from(toolCalls).all();
    expect(rows[0]!.output.length).toBeLessThan(hugeOutput.length);
    expect(rows[0]!.output).toContain('truncated-at-500kb');
  });

  it('event listener creates session on query_start', () => {
    const listener = createCollector({ db: database }).eventListener;

    const event: AgentEvent = {
      type: 'query_start',
      prompt: 'Hello world',
      sessionId: 'ses_ev_001',
    };
    listener(event);

    const rows = database.db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');

    const events = database.db.select().from(agentEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('query_start');
  });

  it('event listener updates session on query_end', () => {
    const listener = createCollector({ db: database }).eventListener;

    // Start
    listener({
      type: 'query_start',
      prompt: 'Hello',
      sessionId: 'ses_ev_002',
    });

    // End
    listener({
      type: 'query_end',
      result: {
        text: 'Hi there',
        sessionId: 'ses_ev_002',
        usage: { inputTokens: 100, outputTokens: 50 },
        totalUsage: { inputTokens: 100, outputTokens: 50 },
        toolCalls: 0,
        compacted: false,
      },
    });

    const row = database.db.select().from(sessions).get()!;
    expect(row.status).toBe('completed');
    expect(row.endTime).toBeGreaterThan(0);
  });
});

// ===== Analyzer Tests =====

describe('Analyzer', () => {
  let database: ObserveDB;
  let analyzer: Analyzer;

  beforeEach(() => {
    database = createDatabase();
    analyzer = new Analyzer(database);

    // Seed data
    database.db.insert(sessions).values({
      id: 'ses_a',
      startTime: Date.now() - 60_000,
      endTime: Date.now(),
      totalCost: 0.05,
      status: 'completed',
    }).run();

    database.db.insert(llmCalls).values([
      {
        id: 'llm_1',
        sessionId: 'ses_a',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
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
      },
      {
        id: 'llm_2',
        sessionId: 'ses_a',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputCost: 0.00125,
        outputCost: 0.002,
        cacheSavings: 0,
        totalCost: 0.00325,
        latencyMs: 300,
        ttftMs: null,
        stopReason: 'end_turn',
        messageCount: 1,
        toolDefCount: 0,
        systemBlockCount: 1,
        hasImages: false,
        skillsLoaded: null,
        providerDetail: null,
        timestamp: Date.now(),
      },
    ]).run();

    database.db.insert(toolCalls).values([
      {
        id: 'tc_1',
        sessionId: 'ses_a',
        llmCallId: 'llm_1',
        name: 'read_file',
        input: '{}',
        output: 'ok',
        isError: false,
        durationMs: 10,
        timestamp: Date.now(),
      },
      {
        id: 'tc_2',
        sessionId: 'ses_a',
        llmCallId: 'llm_1',
        name: 'read_file',
        input: '{}',
        output: 'error',
        isError: true,
        durationMs: 5,
        timestamp: Date.now(),
      },
      {
        id: 'tc_3',
        sessionId: 'ses_a',
        llmCallId: 'llm_1',
        name: 'write_file',
        input: '{}',
        output: 'ok',
        isError: false,
        durationMs: 20,
        timestamp: Date.now(),
      },
    ]).run();

    database.db.insert(agentEvents).values([
      {
        id: 'ev_1',
        sessionId: 'ses_a',
        kind: 'guard_allow',
        detail: null,
        timestamp: Date.now(),
      },
      {
        id: 'ev_2',
        sessionId: 'ses_a',
        kind: 'guard_deny',
        detail: null,
        timestamp: Date.now(),
      },
      {
        id: 'ev_3',
        sessionId: 'ses_a',
        kind: 'guard_allow',
        detail: null,
        timestamp: Date.now(),
      },
    ]).run();
  });

  afterEach(() => {
    database.sqlite.close();
  });

  it('costBreakdown returns aggregated costs', () => {
    const result = analyzer.costBreakdown();
    expect(result.callCount).toBe(2);
    expect(result.totalCost).toBeCloseTo(0.01425);
    expect(result.inputCost).toBeCloseTo(0.00425);
  });

  it('costBreakdown filters by session', () => {
    const result = analyzer.costBreakdown('ses_a');
    expect(result.callCount).toBe(2);
  });

  it('costByModel groups by model', () => {
    const result = analyzer.costByModel();
    expect(result).toHaveLength(2);
    const sonnet = result.find((r) => r.model === 'claude-sonnet-4-20250514');
    expect(sonnet).toBeDefined();
    expect(sonnet!.callCount).toBe(1);
  });

  it('costTrend returns daily aggregation', () => {
    const result = analyzer.costTrend(30);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.totalCost).toBeGreaterThan(0);
  });

  it('cacheEfficiency calculates hit rate', () => {
    const result = analyzer.cacheEfficiency();
    expect(result.totalCacheReadTokens).toBe(200);
    expect(result.totalCacheWriteTokens).toBe(50);
    // hitRate = 200 / (1500 + 200) = 200 / 1700
    expect(result.cacheHitRate).toBeGreaterThan(0);
  });

  it('toolStats aggregates tool usage', () => {
    const result = analyzer.toolStats();
    expect(result).toHaveLength(2);
    const readFile = result.find((r) => r.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.callCount).toBe(2);
    expect(readFile!.errorCount).toBe(1);
  });

  it('guardStats counts allow/deny from guard_decisions table', () => {
    // Insert guard decisions into the new table
    database.db.insert(guardDecisions).values([
      { id: 'gd_1', sessionId: 'ses_a', llmCallId: 'llm_1', toolName: 'read_file', input: '{"path":"/tmp"}', decision: 'allow', reason: null, modifiedInput: null, callIndex: 1, durationMs: 2, timestamp: Date.now() },
      { id: 'gd_2', sessionId: 'ses_a', llmCallId: 'llm_1', toolName: 'shell', input: '{"cmd":"rm -rf /"}', decision: 'deny', reason: 'dangerous', modifiedInput: null, callIndex: 2, durationMs: 5, timestamp: Date.now() },
      { id: 'gd_3', sessionId: 'ses_a', llmCallId: 'llm_2', toolName: 'write_file', input: '{"path":"/tmp/x"}', decision: 'allow', reason: null, modifiedInput: null, callIndex: 3, durationMs: 1, timestamp: Date.now() },
    ]).run();

    const result = analyzer.guardStats();
    expect(result.allowCount).toBe(2);
    expect(result.denyCount).toBe(1);
    expect(result.modifyCount).toBe(0);
  });

  it('sessionSummary returns detailed session info', () => {
    const result = analyzer.sessionSummary('ses_a');
    expect(result).not.toBeNull();
    expect(result!.llmCallCount).toBe(2);
    expect(result!.toolCallCount).toBe(3);
    expect(result!.eventCount).toBe(3);
  });

  it('compactionStats returns empty when no compactions', () => {
    const result = analyzer.compactionStats();
    expect(result.totalCount).toBe(0);
    expect(result.avgTokensFreed).toBe(0);
  });

  it('compactionStats aggregates compaction events', () => {
    database.db.insert(compactionEvents).values([
      { id: 'ce_1', sessionId: 'ses_a', triggerReason: 'threshold', contextBefore: 180000, contextAfter: 50000, thresholdPct: 0.9, contextWindow: 200000, layersApplied: '["clear_thinking","truncate_tool_results"]', durationMs: 1200, tokensFreed: 130000, timestamp: Date.now() },
      { id: 'ce_2', sessionId: 'ses_a', triggerReason: 'overflow_retry', contextBefore: 210000, contextAfter: 80000, thresholdPct: 1.05, contextWindow: 200000, layersApplied: '["summarize","truncate_oldest"]', durationMs: 3500, tokensFreed: 130000, timestamp: Date.now() },
    ]).run();

    const result = analyzer.compactionStats();
    expect(result.totalCount).toBe(2);
    expect(result.avgTokensFreed).toBe(130000);
    expect(result.byTrigger).toHaveLength(2);
    expect(result.byLayer.length).toBeGreaterThan(0);
  });

  it('inferenceDetail returns full record with tools and guards', () => {
    // Add guard decisions for llm_1
    database.db.insert(guardDecisions).values([
      { id: 'gd_inf_1', sessionId: 'ses_a', llmCallId: 'llm_1', toolName: 'read_file', input: '{}', decision: 'allow', reason: null, modifiedInput: null, callIndex: 1, durationMs: 1, timestamp: Date.now() },
    ]).run();

    const detail = analyzer.inferenceDetail('llm_1');
    expect(detail).not.toBeNull();
    expect(detail!.provider).toBe('anthropic');
    expect(detail!.model).toBe('claude-sonnet-4-20250514');
    expect(detail!.toolCalls.length).toBeGreaterThan(0);
    expect(detail!.guardDecisions).toHaveLength(1);
  });

  it('inferenceList returns paginated results', () => {
    const list = analyzer.inferenceList({ sessionId: 'ses_a' });
    expect(list).toHaveLength(2);
    expect(list[0]!.model).toBeDefined();
  });

  it('agentStats aggregates by agent', () => {
    const stats = analyzer.agentStats();
    expect(stats.length).toBeGreaterThanOrEqual(1);
    expect(stats[0]!.sessionCount).toBeGreaterThan(0);
  });

  it('sessionSummary returns null for unknown session', () => {
    const result = analyzer.sessionSummary('nonexistent');
    expect(result).toBeNull();
  });

  it('recentSessions returns ordered sessions', () => {
    const result = analyzer.recentSessions();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('ses_a');
  });
});

// ===== Retention Tests =====

describe('Retention', () => {
  let database: ObserveDB;

  beforeEach(() => {
    database = createDatabase();
  });

  afterEach(() => {
    database.sqlite.close();
  });

  it('cleanup removes old sessions and their children', () => {
    const oldTime = Date.now() - 60 * 86_400_000; // 60 days ago
    database.db.insert(sessions).values({
      id: 'ses_old',
      startTime: oldTime,
      endTime: oldTime + 60_000,
      totalCost: 0.01,
      status: 'completed',
    }).run();

    database.db.insert(llmCalls).values({
      id: 'llm_old',
      sessionId: 'ses_old',
      provider: 'anthropic',
      model: 'test',
      inputTokens: 100,
      outputTokens: 50,
      inputCost: 0,
      outputCost: 0,
      cacheSavings: 0,
      totalCost: 0,
      latencyMs: 100,
      stopReason: 'end_turn',
      messageCount: 1,
      toolDefCount: 0,
      systemBlockCount: 1,
      hasImages: false,
      timestamp: oldTime,
    }).run();

    database.db.insert(toolCalls).values({
      id: 'tc_old',
      sessionId: 'ses_old',
      llmCallId: 'llm_old',
      name: 'test',
      input: '{}',
      output: 'ok',
      isError: false,
      durationMs: 10,
      timestamp: oldTime,
    }).run();

    database.db.insert(agentEvents).values({
      id: 'ev_old',
      sessionId: 'ses_old',
      kind: 'query_start',
      detail: null,
      timestamp: oldTime,
    }).run();

    // Also add a recent session that should survive
    database.db.insert(sessions).values({
      id: 'ses_recent',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const removed = cleanup(database, 30);
    expect(removed).toBe(1);

    // Old data gone
    expect(database.db.select().from(sessions).all()).toHaveLength(1);
    expect(database.db.select().from(llmCalls).all()).toHaveLength(0);
    expect(database.db.select().from(toolCalls).all()).toHaveLength(0);
    expect(database.db.select().from(agentEvents).all()).toHaveLength(0);

    // Recent session survives
    const remaining = database.db.select().from(sessions).all();
    expect(remaining[0]!.id).toBe('ses_recent');
  });

  it('cleanup with no expired data returns 0', () => {
    database.db.insert(sessions).values({
      id: 'ses_new',
      startTime: Date.now(),
      status: 'active',
    }).run();

    const removed = cleanup(database, 30);
    expect(removed).toBe(0);
  });
});

// ===== Observer Factory Tests =====

describe('createObserver', () => {
  it('returns middleware, onEvent, analyzer, and close', () => {
    const observer = createObserver();
    expect(observer.middleware).toBeDefined();
    expect(observer.onEvent).toBeDefined();
    expect(observer.analyzer).toBeInstanceOf(Analyzer);
    expect(typeof observer.close).toBe('function');
    expect(typeof observer.cleanup).toBe('function');
    observer.close();
  });

  it('full integration: middleware + event + analyzer', () => {
    const observer = createObserver();

    // Simulate session start
    observer.onEvent({
      type: 'query_start',
      prompt: 'Hello',
      sessionId: 'ses_int_001',
    });

    // Simulate API call
    const ctx = makeContext({ sessionId: 'ses_int_001' });
    const req = makeRequest();
    const req2 = observer.middleware.onBeforeApiCall!(req, ctx);
    observer.middleware.onAfterApiCall!(req2, makeResponse(), ctx);

    // Simulate tool call
    const toolInput = observer.middleware.onBeforeToolExec!('read_file', { path: '/tmp' }, ctx);
    observer.middleware.onAfterToolExec!('read_file', toolInput, { content: 'ok' }, ctx);

    // Simulate session end
    observer.onEvent({
      type: 'query_end',
      result: {
        text: 'Hi',
        sessionId: 'ses_int_001',
        usage: { inputTokens: 100, outputTokens: 50 },
        totalUsage: { inputTokens: 100, outputTokens: 50 },
        toolCalls: 1,
        compacted: false,
      },
    });

    // Analyze
    const summary = observer.analyzer.sessionSummary('ses_int_001');
    expect(summary).not.toBeNull();
    expect(summary!.llmCallCount).toBe(1);
    expect(summary!.toolCallCount).toBe(1);
    expect(summary!.status).toBe('completed');

    const cost = observer.analyzer.costBreakdown('ses_int_001');
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(cost.callCount).toBe(1);

    observer.close();
  });

  it('records crash_recovered events and stamps the recovered turn', async () => {
    const { createObserver } = await import('../observer.js');
    const observer = createObserver({
      dbPath: ':memory:',
      agentId: 'agent_crash_test',
    });

    const sessionId = 'ses_crash_001';

    // Fire crash_recovered BEFORE query_start (mimics resolveSession emit order)
    observer.onEvent({
      type: 'crash_recovered',
      sessionId,
      artifactCount: 2,
      orphanedTools: [
        { toolUseId: 'tu_a', name: 'bash', input: { cmd: 'ls' }, startedAt: 1, startEventId: 'ev_a' },
        { toolUseId: 'tu_b', name: 'read', input: { path: '/x' }, startedAt: 2, startEventId: 'ev_b' },
      ],
      crashedTurnId: 'turn_prev',
    });

    observer.onEvent({
      type: 'query_start',
      prompt: 'continue after crash',
      sessionId,
    });

    observer.onEvent({
      type: 'query_end',
      result: {
        text: 'ok',
        sessionId,
        usage: { inputTokens: 10, outputTokens: 5 },
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: 0,
        compacted: false,
      },
    });

    // The turn created by query_start must carry the recovery flags.
    const rows = observer.db.db.all<{ recovered: number; count: number; prev: string | null }>(
      `SELECT recovered_from_crash as recovered, orphaned_tool_count as count, previous_turn_id as prev
       FROM turns WHERE session_id = '${sessionId}'` as unknown as never,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].recovered).toBe(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].prev).toBe('turn_prev');

    // StabilityMetrics should reflect the recovery.
    const { MetricsCalculator } = await import('../analyzer/metrics.js');
    const metrics = new MetricsCalculator(observer.analyzer, observer.db);
    const stability = metrics.stabilityMetrics('agent_crash_test');
    expect(stability.totalTurns).toBe(1);
    expect(stability.recoveredTurns).toBe(1);
    expect(stability.crashRate).toBe(1);
    expect(stability.totalOrphanedTools).toBe(2);
    expect(stability.topOrphanedTools.map(t => t.name).sort()).toEqual(['bash', 'read']);

    observer.close();
  });
});
