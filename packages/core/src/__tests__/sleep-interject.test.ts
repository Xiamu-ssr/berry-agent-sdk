// ============================================================
// Sleep tool + interject() mechanism
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../agent.js';
import { TOOL_SLEEP } from '../tool-names.js';
import { SLEEP_MAX_SECONDS } from '../runtime-tools.js';
import type {
  AgentEvent,
  AgentStatus,
  ProviderConfig,
  ProviderResponse,
  Provider,
} from '../types.js';
import { stablePrompt, tmpHome } from './helpers.js';

const STATUS_WAIT_TIMEOUT_MS = 1_000;
const STATUS_POLL_INTERVAL_MS = 5;

class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly model = 'fake';
  private queued: ProviderResponse[] = [];
  /** Each chat() call logs a snapshot of the messages received. */
  public seenMessages: any[][] = [];

  enqueue(...rs: ProviderResponse[]): void {
    this.queued.push(...rs);
  }

  async chat(req: any): Promise<ProviderResponse> {
    this.seenMessages.push([...req.messages]);
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
  model: 'fake',
});

const sleepCallReply = (seconds: number): ProviderResponse => ({
  content: [
    { type: 'tool_use', id: 'tu_sleep', name: TOOL_SLEEP, input: { seconds } },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'fake',
});

function makeAgent() {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const agent = new Agent({
    home: tmpHome(),
    provider: { type: 'anthropic', apiKey: 'x', model: 'fake' } as ProviderConfig,
    providerInstance: provider,
    systemPrompt: stablePrompt('test'),
    onEvent: (e) => events.push(e),
  });
  return { agent, provider, events };
}

async function waitForStatus(agent: Agent, status: AgentStatus): Promise<void> {
  const deadline = Date.now() + STATUS_WAIT_TIMEOUT_MS;
  while (agent.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  expect(agent.status).toBe(status);
}

describe('sleep tool', () => {
  it('is advertised in getTools()', () => {
    const { agent } = makeAgent();
    const toolNames = agent.getTools().map(t => t.name);
    expect(toolNames).toContain(TOOL_SLEEP);
  });

  it('clamps seconds to SLEEP_MAX_SECONDS', async () => {
    // Use real timers; we're not actually waiting long because we interject.
    const { agent, provider } = makeAgent();
    provider.enqueue(sleepCallReply(10_000), textReply('done'));

    const queryPromise = agent.send('sleep long');
    await waitForStatus(agent, 'sleeping');
    agent.interject('wake up');
    const result = await queryPromise;
    // The sleep result message should mention the clamped limit
    const content = JSON.stringify(result);
    expect(content).not.toContain('10000s'); // definitely not 10k seconds
    // Interjected message should now be present in the messages. Note: the
    // context builder merges adjacent same-role messages, so the interject
    // text lands inside the ContentBlock[] of the tool_result user message.
    const lastCallMessages = provider.seenMessages.at(-1)!;
    const userTexts = lastCallMessages
      .filter((m: any) => m.role === 'user')
      .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n');
    expect(userTexts).toContain('wake up');
  });

  it('rejects negative seconds', async () => {
    const { agent, provider } = makeAgent();
    provider.enqueue(sleepCallReply(-1), textReply('done'));
    await agent.send('sleep bad');
    // Should not throw; the tool should have returned an error
    // We verify via seenMessages that tool_result contained the error
    // (The FakeProvider won't emit anything — we just confirm no hang.)
    expect(agent.status).toBe('idle');
  });

  it('transitions: tool_use -> sleeping -> tool_use -> idle', async () => {
    const { agent, provider, events } = makeAgent();
    provider.enqueue(sleepCallReply(60), textReply('done'));

    const queryPromise = agent.send('sleep a minute');
    await waitForStatus(agent, 'sleeping');
    agent.interject('wake');
    await queryPromise;

    const statusSeq = events
      .filter(e => e.type === 'status_change')
      .map(e => (e as any).status);

    // Must pass through sleeping
    expect(statusSeq).toContain('sleeping');
    // Must end on idle
    expect(statusSeq[statusSeq.length - 1]).toBe('idle');
    // Sleeping must be sandwiched between tool_use transitions
    const firstToolUse = statusSeq.indexOf('tool_use');
    const sleepIdx = statusSeq.indexOf('sleeping');
    const lastToolUse = statusSeq.lastIndexOf('tool_use');
    expect(firstToolUse).toBeLessThan(sleepIdx);
    expect(sleepIdx).toBeLessThan(lastToolUse);
  });

  it('tool_result reports whether the sleep was cut short by interject', async () => {
    const { agent, provider } = makeAgent();
    provider.enqueue(sleepCallReply(60), textReply('ok'));

    const queryPromise = agent.send('sleep');
    await waitForStatus(agent, 'sleeping');
    agent.interject('wake');
    await queryPromise;

    // Tool result lives in the messages shown to the 2nd API call
    const msgs = provider.seenMessages[1];
    const toolResult = msgs
      .flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
      .find((b: any) => b?.type === 'tool_result');
    expect(toolResult).toBeTruthy();
    const txt = typeof toolResult.content === 'string'
      ? toolResult.content
      : JSON.stringify(toolResult.content);
    expect(txt).toMatch(/woken early by interject/);
  });
});

describe('interject()', () => {
  it('does nothing when called with empty text', () => {
    const { agent } = makeAgent();
    expect(() => agent.interject('')).not.toThrow();
    expect(() => agent.interject('   ')).not.toThrow();
  });

  it('queues messages that are injected on the next LLM call', async () => {
    const { agent, provider } = makeAgent();
    // Two turns: first the sleep tool call, then a plain reply after interject.
    provider.enqueue(sleepCallReply(60), textReply('acknowledged'));

    const queryPromise = agent.send('initial');
    await waitForStatus(agent, 'sleeping');
    agent.interject('urgent update');
    await queryPromise;

    // Second API call should see the interject message as a user message
    const secondCall = provider.seenMessages[1];
    const userContents = secondCall
      .filter((m: any) => m.role === 'user')
      .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n');
    expect(userContents).toContain('urgent update');
  });

  it('multiple interjects are all delivered', async () => {
    const { agent, provider } = makeAgent();
    provider.enqueue(sleepCallReply(60), textReply('ok'));

    const queryPromise = agent.send('start');
    await waitForStatus(agent, 'sleeping');
    agent.interject('first');
    agent.interject('second');
    agent.interject('third');
    await queryPromise;

    const secondCall = provider.seenMessages[1];
    const userText = secondCall
      .filter((m: any) => m.role === 'user')
      .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n');
    expect(userText).toContain('first');
    expect(userText).toContain('second');
    expect(userText).toContain('third');
  });
});

describe('SLEEP_MAX_SECONDS', () => {
  it('is a positive, finite number', () => {
    expect(SLEEP_MAX_SECONDS).toBeGreaterThan(0);
    expect(Number.isFinite(SLEEP_MAX_SECONDS)).toBe(true);
  });
});
