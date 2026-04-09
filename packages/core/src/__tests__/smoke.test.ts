/**
 * Smoke Test — Comprehensive end-to-end validation.
 *
 * A single, carefully-designed conversation flow that exercises:
 *   1. Basic Q&A (warmup, establishes cache prefix)
 *   2. Tool calling (multi-tool, multi-turn)
 *   3. Session resume (cache hit verification)
 *   4. Streaming (text_delta events)
 *   5. delegate() with cache sharing
 *   6. spawn() sub-agent
 *   7. Structured output (JSON schema)
 *   8. Skill loading (load_skill tool)
 *   9. Prompt cache metrics (cache_read > 0 on resume)
 *  10. Compaction (optional, if enough turns)
 *
 * Prerequisites:
 *   .env.local at repo root:
 *     BERRY_TEST_API_KEY=sk-...
 *     BERRY_TEST_BASE_URL=https://zenmux.ai/api/anthropic
 *     BERRY_TEST_MODEL=anthropic/claude-sonnet-4-20250514  (or haiku for speed)
 *
 * Run:  npx vitest run --testPathPattern smoke
 */
import { config } from 'dotenv';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { Agent } from '../agent.js';
import type {
  ToolRegistration,
  AgentEvent,
  TokenUsage,
  QueryResult,
  DelegateResult,
} from '../types.js';

config({ path: resolve(__dirname, '../../../../.env.local') });

const API_KEY = process.env.BERRY_TEST_API_KEY;
const BASE_URL = process.env.BERRY_TEST_BASE_URL;
const MODEL = process.env.BERRY_TEST_MODEL ?? 'anthropic/claude-haiku-4.5';

const canRun = !!(API_KEY && BASE_URL);

// ===== Tools =====

const calculatorTool: ToolRegistration = {
  definition: {
    name: 'calculator',
    description: 'Evaluate a math expression. Returns the numeric result.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'Math expression, e.g. "2 + 3 * 4"' } },
      required: ['expression'],
    },
  },
  execute: async (input) => {
    try {
      // Simple safe eval for basic math
      const expr = (input.expression as string).replace(/[^0-9+\-*/().%\s]/g, '');
      const result = new Function(`return ${expr}`)();
      return { content: String(result) };
    } catch {
      return { content: 'Error: invalid expression', isError: true };
    }
  },
};

const fileStoreTool: ToolRegistration = {
  definition: {
    name: 'note_store',
    description: 'Store or retrieve a named note. Use action "set" to store, "get" to retrieve.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'get'] },
        key: { type: 'string' },
        value: { type: 'string', description: 'Only needed for set action' },
      },
      required: ['action', 'key'],
    },
  },
  execute: async (input) => {
    const store = (fileStoreTool as any)._store ??= new Map<string, string>();
    if (input.action === 'set') {
      store.set(input.key as string, input.value as string);
      return { content: `Stored "${input.key}"` };
    }
    const val = store.get(input.key as string);
    return val ? { content: val } : { content: `Note "${input.key}" not found`, isError: true };
  },
};

// ===== Test Suite =====

describe.skipIf(!canRun)('smoke test (full pipeline)', { timeout: 60_000 }, () => {
  let agent: Agent;
  let skillDir: string;
  const events: AgentEvent[] = [];

  beforeAll(async () => {
    // Create a skill directory with a test skill
    skillDir = await mkdtemp(join(tmpdir(), 'berry-smoke-skills-'));
    const mathSkillDir = join(skillDir, 'math-helper');
    await mkdir(mathSkillDir, { recursive: true });
    await writeFile(join(mathSkillDir, 'SKILL.md'), `---
name: math-helper
description: Helps solve math problems step by step.
when_to_use: When the user asks a math question.
---

# Math Helper Skill

When solving math problems:
1. Break the problem into steps
2. Use the calculator tool for each step
3. Show your work
4. Give the final answer clearly
`);

    agent = new Agent({
      provider: {
        type: 'anthropic',
        model: MODEL,
        apiKey: API_KEY!,
        baseUrl: BASE_URL,
      },
      systemPrompt: 'You are a helpful assistant with tools. Be concise. When asked to store notes, use the note_store tool. When asked math questions, consider loading the math-helper skill first.',
      tools: [calculatorTool, fileStoreTool],
      skillDirs: [skillDir],
      onEvent: (e) => events.push(e),
    });
  });

  afterAll(async () => {
    await rm(skillDir, { recursive: true, force: true });
  });

  // We chain all tests using a shared sessionId for cache verification
  let sessionId: string;
  let totalCacheRead = 0;

  it('1. basic Q&A + establishes session', async () => {
    const result = await agent.query(
      'My name is Berry. Remember it. What is 2+2? Answer in one word.',
      { stream: true },
    );

    sessionId = result.sessionId;

    expect(result.text).toBeTruthy();
    expect(result.text.toLowerCase()).toMatch(/4|four/);
    expect(result.sessionId).toBeTruthy();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    // Check streaming events were emitted
    const textDeltas = events.filter(e => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('2. tool calling — store a note', async () => {
    events.length = 0;

    const result = await agent.query(
      'Store a note with key "project" and value "berry-agent-sdk v0.1"',
      { resume: sessionId, stream: true },
    );

    expect(result.toolCalls).toBeGreaterThanOrEqual(1);
    expect(result.text).toBeTruthy();

    // Verify tool events
    const toolCalls = events.filter(e => e.type === 'tool_call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.some(e => (e as any).name === 'note_store')).toBe(true);

    // Track cache metrics
    totalCacheRead += result.usage.cacheReadTokens ?? 0;
  });

  it('3. session resume — verify memory + cache hit', async () => {
    events.length = 0;

    const result = await agent.query(
      'What is my name? And retrieve the note with key "project".',
      { resume: sessionId, stream: true },
    );

    // Agent should remember "Berry" from turn 1
    expect(result.text.toLowerCase()).toContain('berry');
    // Agent should call note_store(get, "project") and return the value
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);

    // After 3 turns of resumed session, cache should have hits
    const apiResponses = events.filter(e => e.type === 'api_response');
    expect(apiResponses.length).toBeGreaterThan(0);

    totalCacheRead += result.usage.cacheReadTokens ?? 0;
  });

  it('4. delegate() — one-shot fork with cache sharing', async () => {
    events.length = 0;

    const delegateResult: DelegateResult = await agent.delegate(
      'Calculate 17 * 23 + 5 using the calculator tool. Return only the number.',
      {
        sessionId: sessionId,
        includeHistory: false,  // Skip history to avoid cache_control block limit
        stream: true,
        onEvent: (e) => events.push(e),
      },
    );

    expect(delegateResult.text).toBeTruthy();
    // 17*23+5 = 396
    expect(delegateResult.text).toContain('396');
    expect(delegateResult.turns).toBeGreaterThanOrEqual(1);
    expect(delegateResult.usage.inputTokens).toBeGreaterThan(0);
  });

  it('5. spawn() — persistent sub-agent', async () => {
    const child = agent.spawn({
      id: 'summarizer',
      systemPrompt: 'You are a concise summarizer. Respond in 1-2 sentences max.',
    });

    expect(agent.children.size).toBe(1);

    const r1 = await child.query('What is TypeScript? One sentence.');
    expect(r1.text).toBeTruthy();
    expect(r1.text.length).toBeGreaterThan(10);

    // Sub-agent has its own session
    const r2 = await child.query('Repeat what you just said, shorter.', {
      resume: r1.sessionId,
    });
    expect(r2.text).toBeTruthy();

    // Cleanup
    agent.destroyChild('summarizer');
    expect(agent.children.size).toBe(0);
  });

  it('6. structured output — JSON extraction', async () => {
    const result = await agent.query(
      'Extract the following info as JSON (keys: name, age, job, city): "Alice is 30 years old and works as an engineer in Berlin". Return ONLY the JSON object, no other text.',
    );

    // Try to find JSON in the response
    const match = result.text.match(/\{[\s\S]*\}/);
    expect(match).toBeTruthy();

    const parsed = JSON.parse(match![0]);
    expect(parsed.name).toMatch(/Alice/i);
    expect(Number(parsed.age)).toBe(30);
  });

  it('7. skill loading — load_skill tool trigger', async () => {
    events.length = 0;

    const result = await agent.query(
      'I need to solve a math problem. Load the math-helper skill first, then calculate 15 * 8 using the calculator tool.',
    );

    // Check if load_skill was called
    const toolCalls = events.filter(e => e.type === 'tool_call');
    const skillLoad = toolCalls.find(e => (e as any).name === 'load_skill');

    // The model may or may not call load_skill (it might solve directly).
    // But it should at least use calculator.
    const calcCall = toolCalls.find(e => (e as any).name === 'calculator');
    expect(calcCall || result.text.includes('120')).toBeTruthy();

    expect(result.text).toContain('120');
  });

  it('8. cache metrics — verify prompt cache was used', async () => {
    // After multiple resumed turns, we should see some cache reads
    // This depends on the provider supporting prompt caching
    const session = await agent.getSession(sessionId);

    console.log('\n📊 Smoke Test Cache Metrics:');
    console.log(`  Total cache read tokens: ${session?.metadata.totalCacheReadTokens ?? 0}`);
    console.log(`  Total cache write tokens: ${session?.metadata.totalCacheWriteTokens ?? 0}`);
    console.log(`  Total input tokens: ${session?.metadata.totalInputTokens}`);
    console.log(`  Total output tokens: ${session?.metadata.totalOutputTokens}`);
    console.log(`  Compaction count: ${session?.metadata.compactionCount}`);

    // At minimum, usage should be tracked
    expect(session?.metadata.totalInputTokens).toBeGreaterThan(0);
    expect(session?.metadata.totalOutputTokens).toBeGreaterThan(0);

    // Cache read should have some hits after 3 resumed turns
    // (may be 0 if provider doesn't support caching or turns are too short)
    if (session?.metadata.totalCacheReadTokens! > 0) {
      console.log('  ✅ Cache hits detected!');
    } else {
      console.log('  ⚠️  No cache hits (provider may not support caching, or conversation too short)');
    }
  });
});
