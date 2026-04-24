import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../agent.js';
import { normalizeSystemPrompt } from '../types.js';
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolRegistration,
  TokenUsage,
  Middleware,
} from '../types.js';

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
          systemPrompt: [...request.systemPrompt, 'INJECTED BY MIDDLEWARE'],
        };
      },
    };

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'Base prompt.',
      middleware: [mw],
    });

    await agent.query('Hello');

    expect(capturedRequests).toHaveLength(1);
    // The original didn't have the injected text
    expect(capturedRequests[0]!.systemPrompt).toEqual(normalizeSystemPrompt('Base prompt.'));
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
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'Base.',
      middleware: [mw],
    });

    await agent.query('Hi');

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
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'Base.',
      tools: [echoTool],
      middleware: [mw],
    });

    await agent.query('Echo something');

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
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'Base.',
      tools: [readTool],
      middleware: [mw],
    });

    await agent.query('Read file');

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
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'Base.',
      middleware: [mw1, mw2],
    });

    await agent.query('Hi');

    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw1-after', 'mw2-after']);
  });
});
