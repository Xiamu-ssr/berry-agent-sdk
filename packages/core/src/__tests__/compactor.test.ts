import { describe, expect, it } from 'vitest';

import { compact } from '../compaction/compactor.js';
import type { Message, Provider, ProviderRequest, ProviderResponse } from '../types.js';

class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;

  constructor(private readonly response?: ProviderResponse) {}

  async chat(_request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.response) {
      throw new Error('chat should not be called');
    }
    return structuredClone(this.response);
  }
}

describe('compact', () => {
  it('truncates oversized tool results', async () => {
    const longResult = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool_1',
            content: longResult,
          },
        ],
      },
    ];

    const result = await compact(
      messages,
      {
        contextWindow: 100,
        threshold: 1,
        enabledLayers: ['truncate_tool_results'],
      },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['truncate_tool_results']);
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(result.messages[0].compacted).toBe(true);
    expect(result.messages[0].content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'tool_1',
      }),
    ]);
    const content = (result.messages[0].content as any[])[0].content as string;
    expect(content).toContain('[...truncated');
    expect(content).toContain('line 1');
    expect(content).toContain('line 120');
  });

  it('summarizes old messages and keeps recent tail', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i + 1}`,
      createdAt: i + 1,
    }));

    const result = await compact(
      messages,
      {
        contextWindow: 100,
        threshold: 1,
        enabledLayers: ['summarize'],
      },
      new FakeProvider({
        content: [{ type: 'text', text: 'short summary' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );

    expect(result.layersApplied).toEqual(['summarize']);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        role: 'user',
        compacted: true,
      }),
    );
    expect(result.messages[1]).toEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Understood. I have the context from the summary above.',
        compacted: true,
      }),
    );
    expect(result.messages.slice(-3).map((m) => m.content)).toEqual([
      'message 10',
      'message 11',
      'message 12',
    ]);
  });
});
