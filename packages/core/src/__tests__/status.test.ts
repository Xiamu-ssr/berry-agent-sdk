// ============================================================
// Agent Status — runtime state machine
// ============================================================

import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { ProviderConfig, Message, AgentEvent, ToolRegistration, Provider, ProviderResponse } from '../types.js';

/**
 * Minimal in-memory provider used to drive the agent through known states.
 */
class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly model = 'fake-model';
  private queued: ProviderResponse[] = [];

  enqueue(responses: ProviderResponse[]): void {
    this.queued.push(...responses);
  }

  async chat(): Promise<ProviderResponse> {
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }

  async *stream(): AsyncGenerator<any, ProviderResponse> {
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }

  countTokens(): number { return 0; }
}

const textReply = (text: string): ProviderResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'fake-model',
});

const toolCallReply = (name: string, input: Record<string, unknown>): ProviderResponse => ({
  content: [
    { type: 'tool_use', id: 'tu_1', name, input },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'fake-model',
});

describe('Agent status machine', () => {
  const providerConfig: ProviderConfig = { type: 'anthropic', apiKey: 'x', model: 'fake-model' };

  function makeAgent(opts?: {
    tools?: ToolRegistration[];
    events?: AgentEvent[];
  }): { agent: Agent; provider: FakeProvider; events: AgentEvent[] } {
    const provider = new FakeProvider();
    const events = opts?.events ?? [];
    const agent = new Agent({
      provider: providerConfig,
      providerInstance: provider,
      systemPrompt: 'test',
      tools: opts?.tools,
      onEvent: (e) => events.push(e),
    });
    return { agent, provider, events };
  }

  it('starts at idle', () => {
    const { agent } = makeAgent();
    expect(agent.status).toBe('idle');
  });

  it('transitions: idle -> thinking -> idle on plain reply', async () => {
    const { agent, provider, events } = makeAgent();
    provider.enqueue([textReply('hello')]);

    await agent.query('hi');

    expect(agent.status).toBe('idle');

    const statusChanges = events.filter(e => e.type === 'status_change').map(e => (e as any).status);
    expect(statusChanges).toEqual(['thinking', 'idle']);
  });

  it('transitions: thinking -> tool_executing -> thinking -> idle with tool call', async () => {
    const tool: ToolRegistration = {
      definition: { name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
    };
    const { agent, provider, events } = makeAgent({ tools: [tool] });
    provider.enqueue([
      toolCallReply('noop', {}),
      textReply('done'),
    ]);

    await agent.query('run noop');

    const statusChanges = events.filter(e => e.type === 'status_change').map(e => (e as any).status);
    expect(statusChanges).toEqual(['thinking', 'tool_executing', 'thinking', 'idle']);
    expect(agent.status).toBe('idle');
  });

  it('status_detail lists active tool names during tool_executing', async () => {
    const tool: ToolRegistration = {
      definition: { name: 'noop', description: 'n', inputSchema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
    };
    const { agent, provider, events } = makeAgent({ tools: [tool] });
    provider.enqueue([toolCallReply('noop', {}), textReply('done')]);

    await agent.query('x');

    const toolExecEvent = events.find(
      e => e.type === 'status_change' && (e as any).status === 'tool_executing',
    );
    expect(toolExecEvent).toBeDefined();
    expect((toolExecEvent as any).detail).toBe('noop');
  });

  it('transitions to error on provider failure (and stays error after query)', async () => {
    const { agent, provider, events } = makeAgent();
    // Queue nothing — will throw "no responses queued"

    await expect(agent.query('fail')).rejects.toThrow();

    expect(agent.status).toBe('error');
    expect(agent.statusDetail).toContain('no responses queued');

    const statusChanges = events.filter(e => e.type === 'status_change').map(e => (e as any).status);
    expect(statusChanges).toContain('error');
    // After error, status is preserved (not forced to idle)
    expect(statusChanges[statusChanges.length - 1]).toBe('error');
  });

  it('subsequent successful query resets error -> thinking -> idle', async () => {
    const { agent, provider, events } = makeAgent();

    // First query: fails
    await expect(agent.query('fail')).rejects.toThrow();
    expect(agent.status).toBe('error');

    // Second query: succeeds
    provider.enqueue([textReply('ok')]);
    await agent.query('hi');

    expect(agent.status).toBe('idle');

    const statusChanges = events.filter(e => e.type === 'status_change').map(e => (e as any).status);
    // Should include the recovery: error -> thinking -> idle
    const errorIdx = statusChanges.indexOf('error');
    expect(statusChanges.slice(errorIdx + 1)).toEqual(['thinking', 'idle']);
  });

  it('setStatus de-duplicates identical transitions', async () => {
    const { agent, provider, events } = makeAgent();
    provider.enqueue([textReply('ok')]);

    await agent.query('hi');

    const statusChanges = events.filter(e => e.type === 'status_change');
    // Exactly one idle -> thinking -> idle sequence, no repeats
    expect(statusChanges.length).toBe(2);
  });
});
