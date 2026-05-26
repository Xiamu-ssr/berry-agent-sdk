import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../agent.js';
import { normalizeSystemPrompt, SystemPromptCacheMode } from '../index.js';
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolRegistration,
  TokenUsage,
  Middleware,
  CompactionContext,
  CompactionOutcome,
  CompactionStrategy,
} from '../index.js';
import { stablePrompt, tmpHome } from './helpers.js';

function makeUsage(): TokenUsage {
  return { inputTokens: 100, outputTokens: 50 };
}

class SimpleProvider implements Provider {
  readonly type = 'anthropic' as const;
  constructor(private responses: ProviderResponse[]) {}
  private idx = 0;

  async chat(_: ProviderRequest): Promise<ProviderResponse> {
    return structuredClone(this.responses[this.idx++]!);
  }
}

describe('middleware', () => {
  it('onBeforeApiCall can modify the request', async () => {
    const provider = new SimpleProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const capturedRequests: ProviderRequest[] = [];

    const mw: Middleware = {
      onBeforeApiCall: (request) => {
        capturedRequests.push(structuredClone(request));
        // Add a message to the request
        return {
          ...request,
          systemPrompt: [
            ...request.systemPrompt,
            { text: 'INJECTED BY MIDDLEWARE', cache: SystemPromptCacheMode.Stable },
          ],
        };
      },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      _systemPromptOverride: stablePrompt('Base prompt.'),
      middleware: [mw],
    } as any);

    await agent.send('Hello');

    expect(capturedRequests).toHaveLength(1);
    // The original didn't have the injected text
    expect(capturedRequests[0]!.systemPrompt).toEqual(normalizeSystemPrompt(stablePrompt('Base prompt.')));
  });

  it('onAfterApiCall observes the response', async () => {
    const provider = new SimpleProvider([
      {
        content: [{ type: 'text', text: 'response text' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 42, outputTokens: 13 },
      },
    ]);

    const usages: TokenUsage[] = [];
    const mw: Middleware = {
      onAfterApiCall: (_req, res) => {
        usages.push(res.usage);
      },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      middleware: [mw],
    });

    await agent.send('Hi');

    expect(usages).toHaveLength(1);
    expect(usages[0]!.inputTokens).toBe(42);
  });

  it('onBeforeToolExec can modify tool input', async () => {
    const provider = new SimpleProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'echo', input: { value: 'original' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    let executedInput: Record<string, unknown> | null = null;
    const echoTool: ToolRegistration = {
      definition: {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
      execute: async (input) => {
        executedInput = input;
        return { content: `echo: ${input.value}` };
      },
    };

    const mw: Middleware = {
      onBeforeToolExec: (_name, input) => ({
        ...input,
        value: 'modified_by_middleware',
      }),
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      tools: [echoTool],
      middleware: [mw],
    });

    await agent.send('Echo something');

    expect(executedInput).toEqual({ value: 'modified_by_middleware' });
  });

  it('onAfterToolExec observes tool results', async () => {
    const provider = new SimpleProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/etc/hosts' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const readTool: ToolRegistration = {
      definition: {
        name: 'read',
        description: 'Read',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      execute: async () => ({ content: 'file content' }),
    };

    const observedResults: string[] = [];
    const mw: Middleware = {
      onAfterToolExec: (_name, _input, result) => {
        observedResults.push(result.content);
      },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      tools: [readTool],
      middleware: [mw],
    });

    await agent.send('Read file');

    expect(observedResults).toEqual(['file content']);
  });

  it('multiple middleware run in order', async () => {
    const provider = new SimpleProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const order: string[] = [];

    const mw1: Middleware = {
      onBeforeApiCall: (req) => { order.push('mw1-before'); return req; },
      onAfterApiCall: () => { order.push('mw1-after'); },
    };
    const mw2: Middleware = {
      onBeforeApiCall: (req) => { order.push('mw2-before'); return req; },
      onAfterApiCall: () => { order.push('mw2-after'); },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      middleware: [mw1, mw2],
    });

    await agent.send('Hi');

    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw1-after', 'mw2-after']);
  });

  it('onBeforeCompact / onAfterCompact fire around threshold-triggered compaction', async () => {
    // First reply reports high inputTokens to push session past the hard
    // threshold; subsequent replies are small so the second send settles.
    let providerCalls = 0;
    const provider: Provider = {
      type: 'anthropic' as const,
      async chat(_req: ProviderRequest): Promise<ProviderResponse> {
        providerCalls++;
        if (providerCalls === 1) {
          return {
            content: [{ type: 'text', text: 'reply 1' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 180_000, outputTokens: 50 },
          };
        }
        return {
          content: [{ type: 'text', text: 'reply ' + providerCalls }],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 10 },
        };
      },
    };

    // Strategy that actually shortens messages so tokensFreed > 0 and we can
    // observe the outcome shape in onAfterCompact.
    const strategy: CompactionStrategy = {
      async compact(messages) {
        return {
          messages: messages.map((m, i) => (i === 0 ? { ...m, content: 'x' } : m)),
          layersApplied: ['merge_messages'],
          tokensFreed: 1,
        };
      },
    };

    const beforeCalls: CompactionContext[] = [];
    const afterCalls: Array<{ ctx: CompactionContext; outcome: CompactionOutcome }> = [];
    const mw: Middleware = {
      onBeforeCompact: (ctx) => { beforeCalls.push(ctx); },
      onAfterCompact: (ctx, outcome) => { afterCalls.push({ ctx, outcome }); },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      middleware: [mw],
      compaction: { contextWindow: 200_000, threshold: 150_000 },
      compactionStrategy: strategy,
    } as any);

    const first = await agent.send('first');
    // Second call on same session will see lastInputTokens=180k > threshold=150k
    // → triggers soft/hard compaction at turn entry.
    await agent.send('second', { resume: first.sessionId });

    expect(beforeCalls.length).toBeGreaterThan(0);
    expect(afterCalls.length).toBe(beforeCalls.length);

    // First compaction is threshold-driven at turn entry.
    const firstBefore = beforeCalls[0]!;
    expect(firstBefore.reason).toBe('threshold');
    expect(firstBefore.level === 'soft' || firstBefore.level === 'hard').toBe(true);
    expect(firstBefore.tokensBefore).toBe(180_000);

    // Outcome shape for first after-call.
    const firstAfter = afterCalls[0]!;
    expect(firstAfter.ctx).toEqual(firstBefore);
    expect(firstAfter.outcome.tokensFreed).toBeGreaterThan(0);
    expect(firstAfter.outcome.layersApplied).toContain('merge_messages');
    expect(typeof firstAfter.outcome.durationMs).toBe('number');
  });

  it('onBeforeCompact / onAfterCompact fire with reason=overflow_retry on PTL recovery', async () => {
    let callCount = 0;
    const ptlProvider: Provider = {
      type: 'anthropic' as const,
      async chat(_req: ProviderRequest): Promise<ProviderResponse> {
        callCount++;
        if (callCount === 1) {
          const err = new Error('prompt is too long: 250000 tokens > 200000 maximum');
          (err as any).status = 400;
          throw err;
        }
        return {
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 10 },
        };
      },
    };

    const strategy: CompactionStrategy = {
      async compact(messages) {
        return {
          messages: messages.map((m, i) => (i === 0 ? { ...m, content: 'x' } : m)),
          layersApplied: ['overflow_shrink'],
          tokensFreed: 5,
        };
      },
    };

    const beforeCalls: CompactionContext[] = [];
    const afterCalls: Array<{ ctx: CompactionContext; outcome: CompactionOutcome }> = [];
    const mw: Middleware = {
      onBeforeCompact: (ctx) => { beforeCalls.push(ctx); },
      onAfterCompact: (ctx, outcome) => { afterCalls.push({ ctx, outcome }); },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: ptlProvider,
      systemPrompt: stablePrompt('Base.'),
      middleware: [mw],
      compaction: { contextWindow: 1000, threshold: 500 },
      compactionStrategy: strategy,
    } as any);

    const result = await agent.send('trigger ptl');
    expect(result.text).toBe('recovered');

    // PTL overflow_retry must have surfaced via the hooks.
    const overflowBefore = beforeCalls.find((c) => c.reason === 'overflow_retry');
    expect(overflowBefore).toBeDefined();
    expect(overflowBefore!.level).toBe('hard');

    const overflowAfter = afterCalls.find((c) => c.ctx.reason === 'overflow_retry');
    expect(overflowAfter).toBeDefined();
    expect(overflowAfter!.outcome.layersApplied).toContain('overflow_shrink');
    expect(overflowAfter!.outcome.tokensFreed).toBeGreaterThan(0);
  });

  it('errors thrown in onBeforeCompact / onAfterCompact are swallowed', async () => {
    let providerCalls = 0;
    const provider: Provider = {
      type: 'anthropic' as const,
      async chat(_req: ProviderRequest): Promise<ProviderResponse> {
        providerCalls++;
        if (providerCalls === 1) {
          return {
            content: [{ type: 'text', text: 'reply 1' }],
            stopReason: 'end_turn',
            usage: { inputTokens: 180_000, outputTokens: 50 },
          };
        }
        return {
          content: [{ type: 'text', text: 'reply 2' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 10 },
        };
      },
    };

    const strategy: CompactionStrategy = {
      async compact(messages) {
        return {
          messages: messages.map((m, i) => (i === 0 ? { ...m, content: 'x' } : m)),
          layersApplied: ['merge_messages'],
          tokensFreed: 1,
        };
      },
    };

    const mw: Middleware = {
      onBeforeCompact: () => { throw new Error('boom before'); },
      onAfterCompact: () => { throw new Error('boom after'); },
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: stablePrompt('Base.'),
      middleware: [mw],
      compaction: { contextWindow: 200_000, threshold: 150_000 },
      compactionStrategy: strategy,
    } as any);

    const first = await agent.send('first');
    // Second send should complete successfully even though both hooks throw.
    const res = await agent.send('second', { resume: first.sessionId });
    expect(res.text).toBe('reply 2');
  });
});
