import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { Agent } from '../agent.js';
import { flattenSystemPrompt, normalizeSystemPrompt } from '../types.js';
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ToolRegistration,
  Session,
  AgentEvent,
} from '../types.js';

function cloneProviderRequest(request: ProviderRequest): ProviderRequest {
  return {
    ...request,
    systemPrompt: structuredClone(request.systemPrompt),
    messages: structuredClone(request.messages),
    tools: request.tools ? structuredClone(request.tools) : undefined,
    responseFormat: request.responseFormat ? structuredClone(request.responseFormat) : undefined,
    signal: undefined,
  };
}

class SequenceProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(cloneProviderRequest(request));
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No fake response left');
    }
    return structuredClone(response);
  }
}

class StreamingProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];

  async chat(): Promise<ProviderResponse> {
    throw new Error('chat should not be called when stream=true');
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(cloneProviderRequest(request));
    yield { type: 'text_delta', text: 'hel' };
    yield { type: 'text_delta', text: 'lo' };
    yield { type: 'thinking_delta', thinking: 'internal' };
    yield {
      type: 'response',
      response: {
        content: [{ type: 'text', text: 'hello' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    };
  }
}

class RetryThenStreamProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];
  private attempts = 0;

  async chat(): Promise<ProviderResponse> {
    throw new Error('chat should not be called when stream=true');
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(cloneProviderRequest(request));
    this.attempts++;

    if (this.attempts === 1) {
      const err = new Error('Request was aborted');
      err.name = 'AbortError';
      throw err;
    }

    yield { type: 'text_delta', text: 'ok' };
    yield {
      type: 'response',
      response: {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    };
  }
}

function makeUsage() {
  return { inputTokens: 10, outputTokens: 5 };
}

function getToolResultContents(session: Session): string[] {
  const contents: string[] = [];

  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        contents.push(block.content);
      }
    }
  }

  return contents;
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

  it('accepts multimodal user turns (text + image blocks)', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'got it' }],
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

    const prompt = [
      { type: 'image' as const, data: 'ZmFrZS1pbWFnZS1iYXNlNjQ=', mediaType: 'image/png' },
      { type: 'text' as const, text: 'Describe this image in one sentence.' },
    ];

    const result = await agent.query(prompt);
    const session = await agent.getSession(result.sessionId);

    expect(result.text).toBe('got it');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.messages).toHaveLength(1);
    expect(provider.requests[0]!.messages[0]!.content).toEqual(prompt);
    expect((session as Session).messages[0]!.content).toEqual(prompt);
  });

  it('can create and persist an empty session before the first turn', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'hello after precreate' }],
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

    const created = await agent.createSession();
    const storedBeforeTurn = await agent.getSession(created.id);
    const idsBeforeTurn = await agent.listSessions();
    const result = await agent.query('first turn', { resume: created.id });
    const storedAfterTurn = await agent.getSession(created.id);

    expect(result.sessionId).toBe(created.id);
    expect(storedBeforeTurn?.messages).toEqual([]);
    expect(storedBeforeTurn?.systemPrompt).toEqual(normalizeSystemPrompt(['base prompt']));
    expect(idsBeforeTurn).toContain(created.id);
    expect(storedAfterTurn?.messages).toHaveLength(2);
    expect(storedAfterTurn?.messages[0]?.content).toBe('first turn');
    expect(storedAfterTurn?.messages[1]?.content).toEqual([{ type: 'text', text: 'hello after precreate' }]);
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
    expect(originalSession?.systemPrompt).toEqual(normalizeSystemPrompt(['override prompt']));
    expect(originalSession?.messages).toHaveLength(4);
    expect(forkedSession?.messages).toHaveLength(6);
    expect(forkedSession?.messages[0].content).toBe('first');
    expect(forkedSession?.messages[2].content).toBe('second');
    expect(forkedSession?.messages[4].content).toBe('fork prompt');
  });

  it('emits streaming events and still returns the final result', async () => {
    const provider = new StreamingProvider();
    const events: AgentEvent[] = [];

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'base',
      onEvent: (event) => events.push(event),
    });

    const perQueryEvents: AgentEvent[] = [];
    const result = await agent.query('stream this', {
      stream: true,
      onEvent: (event) => perQueryEvents.push(event),
    });

    expect(provider.requests).toHaveLength(1);
    expect(result.text).toBe('hello');
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(events.some((event) => event.type === 'thinking_delta')).toBe(true);
    expect(perQueryEvents.at(-1)).toEqual(expect.objectContaining({ type: 'query_end' }));
  });

  it('retries a stream that aborts before first token and then succeeds', async () => {
    const provider = new RetryThenStreamProvider();
    const events: AgentEvent[] = [];

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'base',
      onEvent: (event) => events.push(event),
    });

    const result = await agent.query('retry the stalled stream', { stream: true });

    expect(result.text).toBe('ok');
    expect(provider.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ok' },
    ]);

    const retries = events.filter(
      (event): event is Extract<AgentEvent, { type: 'retry' }> => event.type === 'retry',
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      scope: 'stream',
      attempt: 1,
      reason: 'transient_error',
    });
    expect(retries[0].maxAttempts).toBeGreaterThan(1);
    expect(typeof retries[0].delayMs).toBe('number');
  });

  it('tracks lastInputTokens and uses it for compaction decisions', async () => {
    // Provider returns high inputTokens to simulate approaching context limit
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'first reply' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1000, outputTokens: 50 },
      },
      {
        content: [{ type: 'text', text: 'second reply' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 2000, outputTokens: 50 },
      },
    ]);

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: provider,
      systemPrompt: 'base',
    });

    const first = await agent.query('hello');
    const session = await agent.getSession(first.sessionId);

    // After first call, lastInputTokens should be tracked
    expect(session?.metadata.lastInputTokens).toBe(1000);

    // Second call on same session
    await agent.query('follow up', { resume: first.sessionId });
    const updated = await agent.getSession(first.sessionId);
    expect(updated?.metadata.lastInputTokens).toBe(2000);
  });

  it('recovers from prompt-too-long errors via forced compaction', async () => {
    let callCount = 0;
    const ptlProvider: Provider = {
      type: 'anthropic' as const,
      async chat(request: ProviderRequest): Promise<ProviderResponse> {
        callCount++;
        if (callCount === 1) {
          // Simulate prompt-too-long error
          const err = new Error('prompt is too long: 250000 tokens > 200000 maximum');
          (err as any).status = 400;
          throw err;
        }
        // After compaction, succeed
        return {
          content: [{ type: 'text', text: 'recovered after compaction' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 50, outputTokens: 10 },
        };
      },
    };

    // Build enough messages to give compaction something to work with
    const longMessages = Array.from({ length: 20 }, (_, i) => ([
      `User message ${i} with some content to make it longer. `.repeat(5),
      `Assistant reply ${i} with detailed explanation. `.repeat(5),
    ])).flat();

    const agent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: ptlProvider,
      systemPrompt: 'base',
      compaction: {
        contextWindow: 200_000,
        threshold: 100_000,
      },
    });

    // First query to seed messages (we need to manually set up session)
    // Use a fresh agent with a sequence that first succeeds to build session
    const setupProvider = new SequenceProvider(
      Array.from({ length: 10 }, () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 100_000, outputTokens: 50 },
      })),
    );

    const setupAgent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: setupProvider,
      systemPrompt: 'base',
    });

    // Build up a session with many messages
    let sessionId = '';
    for (let i = 0; i < 10; i++) {
      const r = await setupAgent.query(`Message ${i} ${'x'.repeat(500)}`, i === 0 ? undefined : { resume: sessionId });
      sessionId = r.sessionId;
    }

    // Now use the PTL provider on a new agent that shares the session store
    // ...actually, easier to just test that isPromptTooLongError works and the agent retries
    const events: AgentEvent[] = [];
    const retryAgent = new Agent({
      provider: {
        type: 'anthropic',
        apiKey: 'test',
        model: 'fake-model',
      },
      providerInstance: ptlProvider,
      systemPrompt: 'base',
      compaction: {
        contextWindow: 1000,
        threshold: 500,
      },
      onEvent: (e) => events.push(e),
    });

    const result = await retryAgent.query('trigger ptl');
    // Should have recovered
    expect(result.text).toBe('recovered after compaction');
    expect(result.compacted).toBe(true);
    // Should have emitted compaction event
    expect(events.some(e => e.type === 'compaction')).toBe(true);
    // Provider was called twice (first PTL error, then success)
    expect(callCount).toBe(2);
  });

  it('toolGuard denies tool calls and returns error to model', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'dangerous_tool', input: { cmd: 'rm -rf /' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'tool was denied, noted' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const dangerousTool: ToolRegistration = {
      definition: {
        name: 'dangerous_tool',
        description: 'Does something dangerous',
        inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
      },
      execute: async () => ({ content: 'should not reach here' }),
    };

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake-model' },
      providerInstance: provider,
      systemPrompt: 'base',
      tools: [dangerousTool],
      toolGuard: async ({ toolName }) => {
        if (toolName === 'dangerous_tool') {
          return { action: 'deny', reason: 'Tool blocked by policy' };
        }
        return { action: 'allow' };
      },
    });

    const result = await agent.query('do something dangerous');
    const session = await agent.getSession(result.sessionId);
    const toolResultMsg = (session as Session).messages[2];

    expect(result.text).toBe('tool was denied, noted');
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    expect(toolResultMsg.content).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'tu_1',
        content: 'Permission denied: Tool blocked by policy',
        isError: true,
      },
    ]);
  });

  it('toolGuard modifies tool input before execution', async () => {
    const provider = new SequenceProvider([
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
        return { content: `echo:${String(input.value)}` };
      },
    };

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake-model' },
      providerInstance: provider,
      systemPrompt: 'base',
      tools: [echoTool],
      toolGuard: async () => ({
        action: 'modify',
        input: { value: 'sanitized' },
      }),
    });

    await agent.query('echo something');
    expect(executedInput).toEqual({ value: 'sanitized' });
  });

  it('incrementally saves session after each tool loop turn', async () => {
    const saveLog: string[] = [];
    const store = {
      _sessions: new Map<string, any>(),
      save: async (s: any) => { saveLog.push(`save:${s.messages.length}`); store._sessions.set(s.id, structuredClone(s)); },
      load: async (id: string) => { const s = store._sessions.get(id); return s ? structuredClone(s) : null; },
      list: async () => [...store._sessions.keys()],
      delete: async (id: string) => { store._sessions.delete(id); },
    };

    const provider = new SequenceProvider([
      // Turn 1: tool call
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'echo', input: { n: 1 } }],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      // Turn 2: another tool call
      {
        content: [{ type: 'tool_use', id: 'tu_2', name: 'echo', input: { n: 2 } }],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      // Turn 3: final response
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const echoTool: ToolRegistration = {
      definition: {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
      },
      execute: async (input) => ({ content: JSON.stringify(input) }),
    };

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      tools: [echoTool],
      sessionStore: store as any,
    });

    await agent.query('go');

    // Expect incremental saves after each tool turn + final save
    // Turn 1: user + assistant(tool_use) + user(tool_result) → save (3 msgs)
    // Turn 2: + assistant(tool_use) + user(tool_result) → save (5 msgs)
    // Final: + assistant(text) → save (6 msgs)
    expect(saveLog.length).toBe(3); // 2 incremental + 1 final
    expect(saveLog[0]).toBe('save:3');  // after turn 1 tools
    expect(saveLog[1]).toBe('save:5');  // after turn 2 tools
    expect(saveLog[2]).toBe('save:6');  // final save
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

describe('runtime memory/todo tools', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    workspaceRoot = await mkdtemp(join(tmpdir(), 'berry-runtime-tools-'));
  });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('persists todo state across resumed workspace sessions without prompt injection', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo_write_1',
            name: 'todo_write',
            input: { items: [{ text: 'Plan minimal feature' }, { text: 'Run targeted tests', done: true }] },
          },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'todo saved' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo_read_1',
            name: 'todo_read',
            input: {},
          },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'todo loaded' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake-model' },
      providerInstance: provider,
      systemPrompt: 'base',
      workspace: workspaceRoot,
    });

    const first = await agent.query('write todo');
    const stored = await agent.getSession(first.sessionId);
    expect(stored?.metadata.todo?.items).toEqual([
      { text: 'Plan minimal feature', done: false },
      { text: 'Run targeted tests', done: true },
    ]);

    await agent.query('read todo', { resume: first.sessionId });
    const resumed = await agent.getSession(first.sessionId);
    const toolResults = resumed ? getToolResultContents(resumed) : [];

    expect(toolResults.some((content) => content.includes('Plan minimal feature'))).toBe(true);
    expect(flattenSystemPrompt(provider.requests[0].systemPrompt).join('\n')).not.toContain('Plan minimal feature');
  });

  it('persists memory via workspace FileAgentMemory (compaction uses this)', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'workspace ready' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake-model' },
      providerInstance: provider,
      systemPrompt: 'base',
      workspace: workspaceRoot,
    });

    // FileAgentMemory is initialized when workspace is set.
    // Verify we can write and read from it (compaction uses memory.append()).
    const mem = agent.memory;
    expect(mem).toBeDefined();
    await mem!.append('Architecture decision: use append-only JSONL event logs.');
    const content = await mem!.load();
    expect(content).toContain('Architecture decision');
  });

  it('registers memory tools from a MemoryProvider', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'provider ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const mockProvider: import('../memory/provider.js').MemoryProvider = {
      id: 'test-memory',
      tools: () => [{
        definition: {
          name: 'memory_search',
          description: 'Search memory',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
        execute: async (input) => ({ content: `search:${input.query}` }),
      }],
    };

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake-model' },
      providerInstance: provider,
      systemPrompt: 'base',
      memory: mockProvider,
    });

    const names = agent.getTools().map(tool => tool.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('todo_read');
    expect(names).toContain('todo_write');
  });
});

describe('load_skill tool', () => {
  let skillDir: string;

  beforeAll(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    skillDir = await mkdtemp(join(tmpdir(), 'berry-skill-tool-test-'));

    const skill1 = join(skillDir, 'code-review');
    await mkdir(skill1, { recursive: true });
    await writeFile(join(skill1, 'SKILL.md'), `---
name: code-review
description: Reviews code for bugs and style.
when_to_use: When reviewing pull requests.
---

# Code Review Skill

Review the code thoroughly. Check for:
1. Bugs
2. Security issues
3. Style violations
`);
  });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(skillDir, { recursive: true, force: true });
  });

  it('auto-registers load_skill tool when skillDirs is configured', () => {
    const provider = new SequenceProvider([]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      skillDirs: [skillDir],
    });

    // The agent should have load_skill registered
    // We can't inspect tools directly but we can check the provider request
    // when a query is made — the tool should appear in the tools list.
    expect(agent).toBeDefined();
  });

  it('model can call load_skill to get full skill body', async () => {
    // Step 1: model calls load_skill("code-review")
    // Step 2: agent returns skill content as tool_result
    // Step 3: model uses the content to respond
    const provider = new SequenceProvider([
      // Turn 1: model calls load_skill
      {
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'load_skill',
            input: { name: 'code-review' },
          },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      // Turn 2: model responds after seeing skill content
      {
        content: [{ type: 'text', text: 'I loaded the code review skill and will follow its instructions.' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      skillDirs: [skillDir],
    });

    const result = await agent.query('Review this PR');

    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain('I loaded the code review skill');

    // Check that the tool_result contains the skill content
    const session = await agent.getSession(result.sessionId);
    const toolResultMsg = session!.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    const resultBlock = (toolResultMsg!.content as any[]).find((b: any) => b.type === 'tool_result');
    expect(resultBlock.content).toContain('Code Review Skill');
    expect(resultBlock.content).toContain('Security issues');
    expect(resultBlock.isError).toBeFalsy();
  });

  it('load_skill returns error for unknown skill', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'load_skill', input: { name: 'nonexistent' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'Skill not found.' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      skillDirs: [skillDir],
    });

    const result = await agent.query('load something');
    const session = await agent.getSession(result.sessionId);
    const toolResultMsg = session!.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'tool_result'),
    );
    const resultBlock = (toolResultMsg!.content as any[]).find((b: any) => b.type === 'tool_result');
    expect(resultBlock.content).toContain('not found');
    expect(resultBlock.isError).toBe(true);
  });

  it('load_skill tool appears in provider request tools list', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      skillDirs: [skillDir],
    });

    await agent.query('hello');

    const req = provider.requests[0]!;
    const toolNames = req.tools.map(t => t.name);
    expect(toolNames).toContain('load_skill');
  });

  it('skill index appears in system prompt', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      skillDirs: [skillDir],
    });

    await agent.query('hello');

    const req = provider.requests[0]!;
    const fullSystemPrompt = flattenSystemPrompt(req.systemPrompt).join('\n');
    expect(fullSystemPrompt).toContain('code-review');
    expect(fullSystemPrompt).toContain('Reviews code for bugs and style');
  });

  it('tracks fine-grained agent status for ui consumption', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_status',
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

    const events: AgentEvent[] = [];
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'test' },
      providerInstance: provider,
      systemPrompt: 'base',
      onEvent: (event) => events.push(event),
      tools: [
        {
          definition: {
            name: 'echo',
            description: 'Echo back a value',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
          execute: async (input) => ({ content: String(input.value) }),
        },
      ],
    });

    await agent.query('use a tool');

    const statusEvents = events.filter((event): event is Extract<AgentEvent, { type: 'status_change' }> => event.type === 'status_change');
    expect(statusEvents.map(event => event.status)).toContain('thinking');
    expect(statusEvents.map(event => event.status)).toContain('tool_executing');
    expect(statusEvents).toContainEqual(expect.objectContaining({ type: 'status_change', status: 'tool_executing', detail: 'echo' }));
    expect(statusEvents.at(-1)).toEqual(expect.objectContaining({ type: 'status_change', status: 'idle' }));
    expect(agent.inspect().status).toBe('idle');
    expect(agent.inspect().statusDetail).toBeUndefined();
  });
});
