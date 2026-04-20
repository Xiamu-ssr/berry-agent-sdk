// ============================================================
// Tests for session repair: orphan tool_use detection + auto-fix
// Also tests the defensive stopReason correction in the agent loop.
// ============================================================

import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type { ContentBlock, Provider, ProviderConfig, ProviderResponse, Session, ToolRegistration } from '../types.js';

// ---- FakeProvider (same pattern as status.test.ts) ----
class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly model = 'fake-model';
  private queued: ProviderResponse[] = [];
  callCount = 0;

  enqueue(responses: ProviderResponse[]): void {
    this.queued.push(...responses);
  }

  async chat(): Promise<ProviderResponse> {
    this.callCount++;
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }

  async *stream(): AsyncGenerator<any, ProviderResponse> {
    this.callCount++;
    const r = this.queued.shift();
    if (!r) throw new Error('FakeProvider: no responses queued');
    return r;
  }
}

const providerConfig: ProviderConfig = { type: 'anthropic', apiKey: 'x', model: 'fake-model' };

const echoTool: ToolRegistration = {
  definition: {
    name: 'echo',
    description: 'Echo input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  execute: async (input) => ({ content: `echo: ${(input as { text: string }).text}` }),
};

function makeAgent(): { agent: Agent; provider: FakeProvider } {
  const provider = new FakeProvider();
  const agent = new Agent({
    provider: providerConfig,
    providerInstance: provider,
    systemPrompt: 'test',
    tools: [echoTool],
  });
  return { agent, provider };
}

/** Create a session directly in the agent's session store */
async function seedSession(agent: Agent, id: string, messages: Session['messages']): Promise<void> {
  const store = (agent as any).sessionStore;
  const session: Session = {
    id,
    messages,
    systemPrompt: ['test'],
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    metadata: { cwd: '/tmp', model: 'fake-model' },
  };
  await store.save(session);
}

// ---- Tests ----

describe('Session repair: orphan tool_use', () => {

  it('repairs a corrupted session where tool_use has no tool_result', async () => {
    const { agent, provider } = makeAgent();

    provider.enqueue([
      {
        content: [{ type: 'text', text: 'All good now.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    // Corrupted messages: tool_use without tool_result
    await seedSession(agent, 'corrupt-1', [
      {
        role: 'user',
        content: 'do something',
        createdAt: Date.now(),
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me call a tool.' },
          { type: 'tool_use', id: 'toolu_orphan_1', name: 'echo', input: { text: 'hello' } },
        ] as ContentBlock[],
        createdAt: Date.now(),
      },
      // NO tool_result — corruption!
      {
        role: 'user',
        content: 'what happened?',
        createdAt: Date.now(),
      },
    ]);

    // Resume the corrupted session — repair should kick in
    const result = await agent.query('continue please', { resume: 'corrupt-1' });

    expect(result.text).toBe('All good now.');
    expect(provider.callCount).toBe(1);

    // Verify synthetic tool_result was injected
    const loaded = await (agent as any).sessionStore.load('corrupt-1');
    const hasSynthetic = loaded!.messages.some(
      (m: any) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.includes('Session repair'),
        ),
    );
    expect(hasSynthetic).toBe(true);
  });

  it('does not repair a healthy session with matching tool_results', async () => {
    const { agent, provider } = makeAgent();

    provider.enqueue([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    // Healthy session: tool_use + matching tool_result
    await seedSession(agent, 'healthy-1', [
      {
        role: 'user',
        content: 'do something',
        createdAt: Date.now(),
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_ok_1', name: 'echo', input: { text: 'hi' } },
        ] as ContentBlock[],
        createdAt: Date.now(),
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_ok_1', content: 'echo: hi' },
        ] as ContentBlock[],
        createdAt: Date.now(),
      },
    ]);

    const result = await agent.query('next', { resume: 'healthy-1' });
    expect(result.text).toBe('ok');

    // No synthetic repair should have been inserted
    const loaded = await (agent as any).sessionStore.load('healthy-1');
    const hasSynthetic = loaded!.messages.some(
      (m: any) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b: any) =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.includes('Session repair'),
        ),
    );
    expect(hasSynthetic).toBe(false);
  });

  it('auto-corrects stopReason when content has tool_use but API says end_turn', async () => {
    const { agent, provider } = makeAgent();

    // Provider returns tool_use content but with stopReason='end_turn' (the bug)
    provider.enqueue([
      {
        content: [
          { type: 'tool_use', id: 'toolu_desync_1', name: 'echo', input: { text: 'test' } },
        ] as ContentBlock[],
        stopReason: 'end_turn', // BUG: should be 'tool_use'
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'Done after tool.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 15, outputTokens: 5 },
      },
    ]);

    const result = await agent.query('use echo tool');

    // The tool should have been executed (loop continued despite bad stopReason)
    expect(provider.callCount).toBe(2);
    expect(result.text).toBe('Done after tool.');
  });
});
