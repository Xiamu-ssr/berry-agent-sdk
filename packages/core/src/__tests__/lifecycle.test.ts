// ============================================================
// Agent lifecycle — dispose / send / snapshot
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
  describe('dispose', () => {
    it('dispose() marks agent disposed; send() rejects', async () => {
      const { agent } = makeAgent();
      expect(agent.isDisposed).toBe(false);
      await agent.dispose();

      expect(agent.status).toBe('disposed');
      expect(agent.isDisposed).toBe(true);
      await expect(agent.send('hi')).rejects.toThrow(/disposed/i);
    });

    it('dispose() is idempotent', async () => {
      const { agent } = makeAgent();
      await agent.dispose();
      await agent.dispose();
      expect(agent.status).toBe('disposed');
    });

    it('delegate() rejects on disposed agent', async () => {
      const { agent } = makeAgent();
      await agent.dispose();
      await expect(agent.delegate('hi')).rejects.toThrow(/disposed/i);
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
      await agent.dispose();
      expect(snap.status).toBe(before);
      expect(agent.status).toBe('disposed');
    });
  });
});
