// ============================================================
// Agent lifecycle — destroy / send / snapshot
// ============================================================

import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { ProviderConfig, Provider, ProviderResponse } from '../index.js';
import { stablePrompt, tmpHome } from './helpers.js';

class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;
  private queued: ProviderResponse[] = [];

  enqueue(responses: ProviderResponse[]): void {
    this.queued.push(...responses);
  }

  async chat(): Promise<ProviderResponse> {
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }

  async *stream(): AsyncGenerator<never, ProviderResponse> {
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }
}

const reply = (text: string): ProviderResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'fake',
});

const providerConfig: ProviderConfig = { type: 'anthropic', apiKey: 'x', model: 'fake' };

function makeAgent(): { agent: Agent; provider: FakeProvider } {
  const provider = new FakeProvider();
  const agent = new Agent({
    home: tmpHome(),
    provider: providerConfig,
    providerInstance: provider,
      systemPrompt: stablePrompt('test'),
  });
  return { agent, provider };
}

describe('Agent lifecycle', () => {
  describe('destroy', () => {
    it('destroy() marks agent destroyed; send() rejects', async () => {
      const { agent } = makeAgent();
      expect(agent.isDestroyed).toBe(false);
      await agent.destroy();

      expect(agent.status).toBe('destroyed');
      expect(agent.isDestroyed).toBe(true);
      await expect(agent.send('hi')).rejects.toThrow(/destroyed/i);
    });

    it('destroy() is idempotent', async () => {
      const { agent } = makeAgent();
      await agent.destroy();
      await agent.destroy();
      expect(agent.status).toBe('destroyed');
    });

    it('delegate() rejects on destroyed agent', async () => {
      const { agent } = makeAgent();
      await agent.destroy();
      await expect(agent.delegate('hi')).rejects.toThrow(/destroyed/i);
    });
  });

  describe('send', () => {
    it('send() runs a single turn and returns text', async () => {
      const { agent, provider } = makeAgent();
      provider.enqueue([reply('pong')]);
      const r = await agent.send('ping');
      expect(r.text).toBe('pong');
    });
  });

  describe('snapshot', () => {
    it('returns a POJO with status + capturedAt', () => {
      const { agent } = makeAgent();
      const snap = agent.snapshot();
      expect(snap.status).toBe('idle');
      expect(snap.capturedAt).toBeTypeOf('number');
      expect(snap.provider.type).toBe('anthropic');
    });

    it('snapshot is frozen at capture time — later state changes do not mutate it', async () => {
      const { agent } = makeAgent();
      const snap = agent.snapshot();
      const before = snap.status;
      await agent.destroy();
      expect(snap.status).toBe(before);
      expect(agent.status).toBe('destroyed');
    });
  });
});
