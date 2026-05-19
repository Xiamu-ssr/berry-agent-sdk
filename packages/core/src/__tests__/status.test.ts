// ============================================================
// Agent Status — runtime state machine (4-state)
// ============================================================
// Post-AGENTS.md refactor: status is one of
//   idle | tool_use | sleeping | destroyed
// Substates (thinking / tool_executing / delegating / compacting / ...)
// live in `detail`, not as distinct statuses.

import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { ProviderConfig, AgentEvent, ToolRegistration, Provider, ProviderResponse } from '../types.js';
import { stablePrompt, tmpHome } from './helpers.js';

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
      home: tmpHome(),
      provider: providerConfig,
      providerInstance: provider,
      systemPrompt: stablePrompt('test'),
      tools: opts?.tools,
      onEvent: (e) => events.push(e),
    });
    return { agent, provider, events };
  }

  it('starts at idle', () => {
    const { agent } = makeAgent();
    expect(agent.status).toBe('idle');
  });

  it('transitions: idle -> tool_use(thinking) -> idle on plain reply', async () => {
    const { agent, provider, events } = makeAgent();
    provider.enqueue([textReply('hello')]);

    await agent.send('hi');

    expect(agent.status).toBe('idle');

    const statusChanges = events.filter(e => e.type === 'status_change') as any[];
    expect(statusChanges.map(e => e.status)).toEqual(['tool_use', 'idle']);
    expect(statusChanges[0].detail).toBe('thinking');
  });

  it('transitions through tool_use substates with tool call', async () => {
    const tool: ToolRegistration = {
      definition: { name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
    };
    const { agent, provider, events } = makeAgent({ tools: [tool] });
    provider.enqueue([
      toolCallReply('noop', {}),
      textReply('done'),
    ]);

    await agent.send('run noop');

    const statusChanges = events.filter(e => e.type === 'status_change') as any[];
    // Every non-idle status is 'tool_use'; details reflect substate.
    expect(statusChanges.map(e => e.status)).toEqual(['tool_use', 'tool_use', 'tool_use', 'idle']);
    expect(statusChanges.map(e => e.detail)).toEqual(['thinking', 'noop', 'thinking', undefined]);
    expect(agent.status).toBe('idle');
  });

  it('status detail names the executing tool during tool_use', async () => {
    const tool: ToolRegistration = {
      definition: { name: 'noop', description: 'n', inputSchema: { type: 'object', properties: {} } },
      execute: async () => ({ content: 'ok' }),
    };
    const { agent, provider, events } = makeAgent({ tools: [tool] });
    provider.enqueue([toolCallReply('noop', {}), textReply('done')]);

    await agent.send('x');

    const toolExecEvent = events.find(
      e => e.type === 'status_change' && (e as any).status === 'tool_use' && (e as any).detail === 'noop',
    );
    expect(toolExecEvent).toBeDefined();
  });

  it('on provider failure, agent returns to idle after throwing', async () => {
    const { agent, events } = makeAgent();
    // Queue nothing — chat() will throw "no responses queued"

    await expect(agent.send('fail')).rejects.toThrow();

    // 4-state machine: no dedicated 'error' status; finally block forces idle.
    expect(agent.status).toBe('idle');

    const statusChanges = events.filter(e => e.type === 'status_change').map(e => (e as any).status);
    expect(statusChanges[statusChanges.length - 1]).toBe('idle');
  });

  it('subsequent successful send works after a failed one', async () => {
    const { agent, provider } = makeAgent();

    await expect(agent.send('fail')).rejects.toThrow();
    expect(agent.status).toBe('idle');

    provider.enqueue([textReply('ok')]);
    const r = await agent.send('hi');
    expect(r.text).toBe('ok');
    expect(agent.status).toBe('idle');
  });

  it('setStatus de-duplicates identical transitions', async () => {
    const { agent, provider, events } = makeAgent();
    provider.enqueue([textReply('ok')]);

    await agent.send('hi');

    const statusChanges = events.filter(e => e.type === 'status_change');
    // tool_use(thinking) -> idle : exactly two transitions
    expect(statusChanges.length).toBe(2);
  });
});
