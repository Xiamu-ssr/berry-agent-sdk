/**
 * Integration tests — hit real API via zenmux proxy.
 *
 * Prerequisites:
 *   .env.local at repo root with:
 *     BERRY_TEST_API_KEY=sk-...
 *     BERRY_TEST_BASE_URL=https://zenmux.ai/api/anthropic
 *     BERRY_TEST_MODEL=anthropic/claude-haiku-4.5
 *
 * Run manually:
 *   npx vitest run --testPathPattern integration
 *
 * These tests are SKIPPED when env vars are missing (CI-safe).
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import { Agent } from '../agent.js';
import type { AgentConfig, QueryResult, ToolRegistration, AgentEvent } from '../types.js';

// Load .env.local from repo root
config({ path: resolve(__dirname, '../../../../.env.local') });

const API_KEY = process.env.BERRY_TEST_API_KEY;
const BASE_URL = process.env.BERRY_TEST_BASE_URL;
const MODEL = process.env.BERRY_TEST_MODEL ?? 'anthropic/claude-haiku-4.5';

const canRun = !!(API_KEY && BASE_URL);

// Use describe.skipIf to gracefully skip in CI
describe.skipIf(!canRun)('integration (real API)', () => {
  let agent: Agent;

  beforeAll(() => {
    agent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant. Be concise.',
      compaction: {
        // Use a tiny context window to trigger compaction easily in tests
        contextWindow: 4_000,
        threshold: 3_000,
      },
    });
  });

  // ============================================================
  // 1. Basic query — single turn, text response
  // ============================================================
  it('answers a simple question', async () => {
    const result = await agent.query('What is 2 + 3? Reply with just the number.');

    expect(result.text).toBeTruthy();
    expect(result.text).toContain('5');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
  }, 30_000);

  // ============================================================
  // 2. Tool calling — register a simple tool and verify it's called
  // ============================================================
  it('calls a registered tool and uses its result', async () => {
    const addTool: ToolRegistration = {
      definition: {
        name: 'add_numbers',
        description: 'Add two numbers together',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
          },
          required: ['a', 'b'],
        },
      },
      execute: async (input: any) => ({
        content: `The sum is ${input.a + input.b}`,
      }),
    };

    const toolAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You have a tool called add_numbers. Use it when asked to add numbers. Reply with just the result.',
      tools: [addTool],
    });

    const events: AgentEvent[] = [];
    const result = await toolAgent.query(
      'Use the add_numbers tool to compute 17 + 25, then tell me the result.',
      { onEvent: (e) => events.push(e) },
    );

    // Should have called the tool
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);

    // Should contain the correct answer
    expect(result.text).toContain('42');

    // Should have emitted tool_call and tool_result events
    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    const toolResultEvents = events.filter(e => e.type === 'tool_result');
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolCallEvents[0]).toEqual(
      expect.objectContaining({ name: 'add_numbers' }),
    );
  }, 30_000);

  // ============================================================
  // 3. Session resume — multi-turn conversation
  // ============================================================
  it('resumes a session and remembers context', async () => {
    const sessionAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant. Be concise.',
    });

    // First turn
    const r1 = await sessionAgent.query('My name is Alice. Remember it.');
    expect(r1.sessionId).toBeTruthy();

    // Second turn — resume session
    const r2 = await sessionAgent.query('What is my name?', {
      resume: r1.sessionId,
    });

    expect(r2.text.toLowerCase()).toContain('alice');
    expect(r2.sessionId).toBe(r1.sessionId);
  }, 30_000);

  // ============================================================
  // 4. Streaming — verify text_delta events fire
  // ============================================================
  it('streams text deltas', async () => {
    const streamAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant.',
    });

    const deltas: string[] = [];
    const result = await streamAgent.query('Say "hello world" and nothing else.', {
      stream: true,
      onEvent: (e) => {
        if (e.type === 'text_delta') {
          deltas.push(e.text);
        }
      },
    });

    // Should have received streaming deltas
    expect(deltas.length).toBeGreaterThan(0);
    // Concatenated deltas should match final text
    const streamed = deltas.join('');
    expect(result.text.trim().toLowerCase()).toContain('hello world');
    expect(streamed.trim().toLowerCase()).toContain('hello world');
  }, 30_000);

  // ============================================================
  // 5. Compaction — trigger with low context window
  // ============================================================
  it('triggers compaction when context exceeds threshold', async () => {
    const compactAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant.',
      compaction: {
        // Extremely low threshold: compaction fires when lastInputTokens > 100
        contextWindow: 1_000,
        threshold: 100,
      },
    });

    // Turn 1: seed with content
    const r1 = await compactAgent.query(
      'Write a detailed paragraph about the Apollo 11 moon landing.',
    );

    // Turn 2: adds more context, after which lastInputTokens ~ 500-1000
    const r2 = await compactAgent.query(
      'Now write a paragraph about the Voyager missions.',
      { resume: r1.sessionId },
    );

    // Turn 3: shouldCompact sees lastInputTokens from turn 2 (~1000+) > threshold (100)
    const events: AgentEvent[] = [];
    const r3 = await compactAgent.query(
      'What were we discussing?',
      {
        resume: r2.sessionId,
        onEvent: (e) => events.push(e),
      },
    );

    // Should have compacted
    expect(r3.compacted).toBe(true);
    const compactionEvents = events.filter(e => e.type === 'compaction');
    expect(compactionEvents.length).toBeGreaterThanOrEqual(1);

    // Should still give a coherent response
    expect(r3.text).toBeTruthy();
    expect(r3.text.length).toBeGreaterThan(10);
  }, 120_000);

  // ============================================================
  // 6. Usage tracking — verify token counts accumulate
  // ============================================================
  it('tracks cumulative usage across turns', async () => {
    const usageAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant. Be concise.',
    });

    const r1 = await usageAgent.query('Say "hi".');
    expect(r1.totalUsage.inputTokens).toBeGreaterThan(0);
    expect(r1.totalUsage.outputTokens).toBeGreaterThan(0);

    const r2 = await usageAgent.query('Say "bye".', { resume: r1.sessionId });
    // Cumulative should be larger than single turn
    expect(r2.totalUsage.inputTokens).toBeGreaterThan(r1.totalUsage.inputTokens);
    expect(r2.totalUsage.outputTokens).toBeGreaterThan(r1.totalUsage.outputTokens);
  }, 30_000);

  // ============================================================
  // 7. Abort signal — cancel mid-request
  // ============================================================
  it('respects abort signal', async () => {
    const abortAgent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant.',
    });

    const controller = new AbortController();

    // Abort almost immediately
    setTimeout(() => controller.abort(), 100);

    await expect(
      abortAgent.query('Write a 500-word essay about artificial intelligence.', {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  }, 15_000);
});
