import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../agent.js';
import { normalizeSystemPrompt } from '../types.js';
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolRegistration,
  TokenUsage,
  Session,
  AgentEvent,
} from '../types.js';
import { tmpHome } from './helpers.js';

// ===== Test Helpers =====

function makeUsage(input = 100, output = 50): TokenUsage {
  return { inputTokens: input, outputTokens: output };
}

class SequenceProvider implements Provider {
  readonly type = 'anthropic' as const;
  private responses: ProviderResponse[];
  private callIndex = 0;
  readonly chatSpy = vi.fn();

  constructor(responses: ProviderResponse[]) {
    this.responses = responses;
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    this.chatSpy(request);
    if (this.callIndex >= this.responses.length) {
      throw new Error('No more responses in sequence');
    }
    return structuredClone(this.responses[this.callIndex++]!);
  }
}

// ===== delegate() =====

describe('delegate', () => {
  it('runs a one-shot fork and returns final text + usage', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'delegate result' }],
        stopReason: 'end_turn',
        usage: makeUsage(200, 80),
      },
    ]);

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test-model' },
      providerInstance: provider,
      systemPrompt: 'You are a coding assistant.',
    });

    const result = await agent.delegate('Summarize the code');

    expect(result.text).toBe('delegate result');
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(80);
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it('runs multi-turn tool loop within delegate', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'test.ts' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(200, 50),
      },
      {
        content: [{ type: 'text', text: 'File content looks good' }],
        stopReason: 'end_turn',
        usage: makeUsage(300, 100),
      },
    ]);

    const readFileTool: ToolRegistration = {
      definition: {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      execute: async () => ({ content: 'file content here' }),
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test-model' },
      providerInstance: provider,
      systemPrompt: 'You are a coding assistant.',
      tools: [readFileTool],
    });

    const result = await agent.delegate('Review test.ts');

    expect(result.text).toBe('File content looks good');
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(500); // 200 + 300
    expect(result.usage.outputTokens).toBe(150); // 50 + 100
  });

  it('includes main conversation history for cache sharing', async () => {
    // First, have a regular conversation
    const mainProvider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'Hello there!' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test-model' },
      providerInstance: mainProvider,
      systemPrompt: 'You are helpful.',
    });

    await agent.send('Hi');

    // Now swap provider for the delegate call
    const delegateProvider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'summary done' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);
    // Inject new provider via the internal field
    (agent as any).provider = delegateProvider;

    const result = await agent.delegate('Summarize our conversation');

    // The delegate should have received the main conversation messages as cache prefix
    const request = delegateProvider.chatSpy.mock.calls[0]![0] as ProviderRequest;
    // Messages: [user: "Hi", assistant: "Hello there!", user: (tool_result), user: "Summarize..."]
    // Note: the main session stores tool_result messages even when there are no tools
    expect(request.messages.length).toBeGreaterThanOrEqual(3);
    expect(request.messages[0]!.content).toBe('Hi');
  });

  it('appendSystemPrompt adds to base system prompt', async () => {
    const provider = new SequenceProvider([
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test-model' },
      providerInstance: provider,
      _systemPromptOverride: 'Base prompt.',
    } as any);

    await agent.delegate('Do something', {
      appendSystemPrompt: 'Extra skill instructions here.',
      includeHistory: false, // no session yet
    });

    const request = provider.chatSpy.mock.calls[0]![0] as ProviderRequest;
    expect(request.systemPrompt).toEqual(
      normalizeSystemPrompt(['Base prompt.', 'Extra skill instructions here.']),
    );
  });

  it('applies toolGuard override for delegate', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
        stopReason: 'tool_use',
        usage: makeUsage(),
      },
      {
        content: [{ type: 'text', text: 'blocked' }],
        stopReason: 'end_turn',
        usage: makeUsage(),
      },
    ]);

    const execTool: ToolRegistration = {
      definition: {
        name: 'exec',
        description: 'Execute command',
        inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
      },
      execute: async () => ({ content: 'should not run' }),
    };

    const agent = new Agent({
      home: tmpHome(),
      provider: { type: 'anthropic', apiKey: 'test', model: 'test-model' },
      providerInstance: provider,
      systemPrompt: 'Base.',
      tools: [execTool],
    });

    const result = await agent.delegate('Run ls', {
      toolGuard: async () => ({ action: 'deny', reason: 'Delegate blocks exec' }),
      includeHistory: false,
    });

    expect(result.text).toBe('blocked');
  });
});

// spawn() was removed from core; persistent sub-agents moved to @berry-agent/team.
