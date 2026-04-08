import { describe, expect, it } from 'vitest';

import { Agent } from '../agent.js';
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolRegistration,
  Session,
} from '../types.js';

class SequenceProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No fake response left');
    }
    return structuredClone(response);
  }
}

function makeUsage() {
  return { inputTokens: 10, outputTokens: 5 };
}

describe('Agent', () => {
  it('runs a tool loop and persists tool results into the session', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'echo',
            input: { value: 'hello' },
          },
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

    const echoTool: ToolRegistration = {
      definition: {
        name: 'echo',
        description: 'Echo back a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      execute: async (input) => ({
        content: `tool:${String(input.value)}`,
      }),
    };

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'You are helpful',
      tools: [echoTool],
    });

    const result = await agent.query('Use the tool');
    const session = await agent.getSession(result.sessionId);

    expect(result.text).toBe('done');
    expect(result.toolCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(20);
    expect(provider.requests).toHaveLength(2);

    expect(session).not.toBeNull();
    const messages = (session as Session).messages;
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(Array.isArray(messages[2].content)).toBe(true);
    expect(messages[2].content).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'toolu_1',
        content: 'tool:hello',
      },
    ]);
    expect(messages[3].content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('records unknown tool failures and keeps looping', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_missing',
            name: 'missing_tool',
            input: { x: 1 },
          },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'handled missing tool' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'You are helpful',
      tools: [],
    });

    const result = await agent.query('Try missing tool');
    const session = await agent.getSession(result.sessionId);
    const toolResultMessage = (session as Session).messages[2];

    expect(result.text).toBe('handled missing tool');
    expect(Array.isArray(toolResultMessage.content)).toBe(true);
    expect(toolResultMessage.content).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'toolu_missing',
        content: 'Error: unknown tool "missing_tool"',
        isError: true,
      },
    ]);
  });

  it('supports resume and fork', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'first reply' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'second reply' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'fork reply' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: ['base prompt'],
    });

    const first = await agent.query('first');
    const resumed = await agent.query('second', {
      resume: first.sessionId,
      systemPrompt: ['override prompt'],
    });
    const forked = await agent.query('fork prompt', { fork: first.sessionId });

    const originalSession = await agent.getSession(first.sessionId);
    const forkedSession = await agent.getSession(forked.sessionId);

    expect(resumed.sessionId).toBe(first.sessionId);
    expect(forked.sessionId).not.toBe(first.sessionId);
    expect(originalSession?.systemPrompt).toEqual(['override prompt']);
    expect(originalSession?.messages).toHaveLength(4);
    expect(forkedSession?.messages).toHaveLength(6);
    expect(forkedSession?.messages[0].content).toBe('first');
    expect(forkedSession?.messages[2].content).toBe('second');
    expect(forkedSession?.messages[4].content).toBe('fork prompt');
  });

  it('stops after maxTurns when the provider keeps asking for tools', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'tool_use', id: 'a', name: 'echo', input: { n: 1 } }],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'tool_use', id: 'b', name: 'echo', input: { n: 2 } }],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
    ]);

    const echoTool: ToolRegistration = {
      definition: {
        name: 'echo',
        description: 'Echo input',
        inputSchema: {
          type: 'object',
          properties: { n: { type: 'number' } },
        },
      },
      execute: async (input) => ({ content: JSON.stringify(input) }),
    };

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'base',
      tools: [echoTool],
    });

    const result = await agent.query('loop forever', { maxTurns: 1 });
    const session = await agent.getSession(result.sessionId);

    expect(provider.requests).toHaveLength(1);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe('');
    expect(session?.messages).toHaveLength(3);
  });
});
