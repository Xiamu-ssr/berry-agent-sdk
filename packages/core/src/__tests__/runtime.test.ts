import { describe, expect, it, vi } from 'vitest';

import { ManagedAgentRuntime } from '../runtime.js';
import type { Provider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '../index.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { ToolGuard } from '../index.js';
import { loadAgentConfigSync } from '../workspace/initializer.js';
import { tmpHome } from './helpers.js';

class StreamingProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];

  async chat(): Promise<ProviderResponse> {
    throw new Error('chat should not be called when stream=true');
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push({
      ...request,
      systemPrompt: structuredClone(request.systemPrompt),
      messages: structuredClone(request.messages),
      tools: request.tools ? structuredClone(request.tools) : undefined,
      signal: undefined,
    });
    yield { type: 'text_delta', text: 'hi' };
    yield {
      type: 'response',
      response: {
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 9, outputTokens: 2 },
      },
    };
  }
}

function createRuntime(): ManagedAgentRuntime {
  const provider = new StreamingProvider();
  return ManagedAgentRuntime.create({
    agentId: 'agent_1',
    config: {
      provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
      providerInstance: provider,
      home: tmpHome('berry-runtime-test-'),
    },
  });
}

describe('ManagedAgentRuntime', () => {
  it('owns chat send lifecycle and hydrates the resulting session view', async () => {
    const runtime = createRuntime();
    const onUserMessagePersisted = vi.fn();
    const onEvent = vi.fn();

    const turn = await runtime.send('hello', {
      requestId: 'request_1',
      onUserMessagePersisted,
      onEvent,
    });

    expect(runtime.getActiveSessionId()).toBe(turn.sessionId);
    expect(onUserMessagePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'hello', requestId: 'request_1' }),
      turn.sessionId,
    );
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', text: 'hi' }));
    expect(turn.assistantMessage).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'hi',
    }));
    expect(turn.view).toEqual(expect.objectContaining({
      id: turn.sessionId,
      agentId: 'agent_1',
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'hello' }),
        expect.objectContaining({ role: 'assistant', content: 'hi' }),
      ]),
    }));
  });

  it('loads, clears, lists, and deletes active sessions without host-side state', async () => {
    const runtime = createRuntime();
    const created = await runtime.createSession();

    expect(runtime.getActiveSessionId()).toBe(created.id);
    expect(await runtime.loadSessionView(created.id)).toEqual(expect.objectContaining({
      id: created.id,
      agentId: 'agent_1',
    }));

    const cleared = await runtime.clearSession();
    expect(cleared.sessionId).toBe(created.id);
    expect(cleared.view?.messages).toEqual([]);

    const listed = await runtime.listSessionViews();
    expect(listed.map((view) => view.id)).toContain(created.id);

    const deleted = await runtime.deleteSession(created.id);
    expect(deleted).toEqual({ sessionId: created.id, wasActive: true });
    expect(runtime.getActiveSessionId()).toBeUndefined();
  });

  it('reports context size from SDK session state', async () => {
    const runtime = createRuntime();

    expect(await runtime.contextSize()).toEqual(expect.objectContaining({
      current: 0,
      window: expect.any(Number),
    }));

    await runtime.send('hello');

    expect(await runtime.contextSize()).toEqual(expect.objectContaining({
      current: 9,
      window: expect.any(Number),
    }));
  });

  it('disposes the underlying agent and clears active session state', async () => {
    const runtime = createRuntime();
    const created = await runtime.createSession();

    expect(runtime.getActiveSessionId()).toBe(created.id);
    await runtime.dispose();

    expect(runtime.getActiveSessionId()).toBeUndefined();
    expect(runtime.isDisposed).toBe(true);
  });

  it('runs dispose hooks when the managed runtime is disposed', async () => {
    let disposed = 0;
    const runtime = ManagedAgentRuntime.create({
      config: {
        provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
        providerInstance: new StreamingProvider(),
        home: tmpHome('berry-runtime-dispose-hook-'),
      },
      disposeHooks: [() => { disposed += 1; }],
    });

    await runtime.dispose();

    expect(disposed).toBe(1);
  });

  it('awaits async dispose hooks before resolving teardown', async () => {
    const events: string[] = [];
    const runtime = ManagedAgentRuntime.create({
      config: {
        provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
        providerInstance: new StreamingProvider(),
        home: tmpHome('berry-runtime-async-dispose-hook-'),
      },
      disposeHooks: [async () => {
        await Promise.resolve();
        events.push('hook');
      }],
    });

    const dispose = runtime.dispose().then(() => events.push('resolved'));
    expect(events).toEqual([]);
    await dispose;

    expect(events).toEqual(['hook', 'resolved']);
  });

  it('awaits memory provider init before the first turn', async () => {
    let initialized = false;
    const memory: MemoryProvider = {
      id: 'test-memory',
      init: vi.fn(async () => {
        await Promise.resolve();
        initialized = true;
      }),
      tools: () => [],
      dispose: vi.fn(),
    };
    const provider = new StreamingProvider();
    const providerInstance: Provider = {
      type: 'anthropic',
      chat: () => provider.chat(),
      stream: async function* (request: ProviderRequest) {
        expect(initialized).toBe(true);
        yield* provider.stream(request);
      },
    };
    const runtime = ManagedAgentRuntime.create({
      config: {
        provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
        providerInstance,
        home: tmpHome('berry-runtime-memory-test-'),
        memory,
      },
    });

    await runtime.send('hello');

    expect(memory.init).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(memory.dispose).toHaveBeenCalledOnce();
  });
});

describe('ManagedAgentRuntime.setClassifierModel', () => {
  it('rebuilds the guard via the captured builder and persists to agent.json', () => {
    const home = tmpHome('berry-runtime-classifier-');
    const builtFor: string[] = [];
    const runtime = ManagedAgentRuntime.create({
      agentId: 'agent_clf',
      config: {
        provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
        providerInstance: new StreamingProvider(),
        home,
        classifierModel: 'tier:cheap',
        // Stand-in for the runtime's real builder: records the model it was
        // asked to build for and returns a trivial guard.
        classifierGuardBuilder: (modelRef: string): ToolGuard => {
          builtFor.push(modelRef);
          return { evaluate: async () => ({ decision: 'allow' }) } as unknown as ToolGuard;
        },
      },
    });

    runtime.setClassifierModel('tier:strong');

    expect(builtFor).toEqual(['tier:strong']);
    // Persisted: a restart rehydrates the new classifier model.
    expect(loadAgentConfigSync(home.root).classifierModel).toBe('tier:strong');
  });

  it('throws when the agent was built without a classifier guard builder', () => {
    const runtime = ManagedAgentRuntime.create({
      agentId: 'agent_no_clf',
      config: {
        provider: { type: 'anthropic', model: 'fake-model', apiKey: 'test' },
        providerInstance: new StreamingProvider(),
        home: tmpHome('berry-runtime-no-clf-'),
      },
    });
    expect(() => runtime.setClassifierModel('tier:strong')).toThrow(/no classifier guard builder/);
  });
});
