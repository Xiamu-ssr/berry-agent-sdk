import { describe, expect, it } from 'vitest';

import { compact, estimateTokens } from '../compaction/compactor.js';
import type { Message, Provider, ProviderRequest, ProviderResponse, ContentBlock } from '../types.js';

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

/** Helper: force all layers to fire by setting threshold=1 */
const FORCE_COMPACT = { contextWindow: 100_000, threshold: 1 };

describe('compact', () => {
  // ===== Layer 1: clear_thinking =====
  it('clears thinking blocks except the most recent one', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'old thinking A' },
          { type: 'text', text: 'response A' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'old thinking B' },
          { type: 'text', text: 'response B' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'latest thinking' },
          { type: 'text', text: 'response C' },
        ],
      },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['clear_thinking'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['clear_thinking']);
    // First two messages should have thinking removed
    expect((result.messages[0].content as ContentBlock[]).some(b => b.type === 'thinking')).toBe(false);
    expect((result.messages[1].content as ContentBlock[]).some(b => b.type === 'thinking')).toBe(false);
    // Last message keeps thinking
    expect((result.messages[2].content as ContentBlock[]).some(b => b.type === 'thinking')).toBe(true);
  });

  // ===== Layer 2: truncate_tool_results =====
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
      { ...FORCE_COMPACT, enabledLayers: ['truncate_tool_results'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['truncate_tool_results']);
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(result.messages[0].compacted).toBe(true);
    const content = (result.messages[0].content as any[])[0].content as string;
    expect(content).toContain('[...truncated');
    expect(content).toContain('line 1');
    expect(content).toContain('line 120');
  });

  it('leaves short tool results untouched', async () => {
    const shortResult = 'line 1\nline 2\nline 3';
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tool_1', content: shortResult }],
      },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['truncate_tool_results'] },
      new FakeProvider(),
    );

    // Layer runs but finds nothing to truncate, so it should NOT appear in layersApplied
    expect(result.layersApplied).not.toContain('truncate_tool_results');
    expect((result.messages[0].content as any[])[0].content).toBe(shortResult);
  });

  // ===== Layer 3: clear_tool_pairs =====
  it('compacts old tool pairs but keeps the 5 most recent', async () => {
    const messages: Message[] = [];
    // Create 8 tool-use → tool-result pairs with enough content to exceed threshold
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t_${i}`, name: `tool_${i}`, input: { n: i, payload: 'x'.repeat(200) } }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: `t_${i}`, content: `${'result-data '.repeat(50)} ${i}` }],
      });
    }

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['clear_tool_pairs'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['clear_tool_pairs']);
    // Oldest 3 pairs (indices 0-5) should be compacted
    for (let i = 0; i < 3; i++) {
      const assistantMsg = result.messages[i * 2];
      expect(assistantMsg.compacted).toBe(true);
      const text = (assistantMsg.content as ContentBlock[])[0];
      expect(text.type).toBe('text');
      expect((text as any).text).toContain('called:');

      const userMsg = result.messages[i * 2 + 1];
      expect(userMsg.compacted).toBe(true);
      expect((userMsg.content as any[])[0].content).toBe('[compacted]');
    }
    // Last 5 pairs (indices 6-15) should be untouched
    const lastToolUse = result.messages[6];
    expect(lastToolUse.compacted).toBeUndefined();
  });

  // ===== Layer 4: merge_messages =====
  it('merges consecutive same-role string messages', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'part 1' },
      { role: 'user', content: 'part 2' },
      { role: 'assistant', content: 'reply' },
      { role: 'assistant', content: 'more reply' },
      { role: 'user', content: 'next question' },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['merge_messages'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['merge_messages']);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe('part 1\npart 2');
    expect(result.messages[0].compacted).toBe(true);
    expect(result.messages[1].content).toBe('reply\nmore reply');
    expect(result.messages[2].content).toBe('next question');
  });

  it('does not merge messages with array content', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'text message' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'result' }] },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['merge_messages'] },
      new FakeProvider(),
    );

    expect(result.messages).toHaveLength(2);
  });

  // ===== Layer 5: summarize =====
  it('summarizes old messages and keeps recent tail', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i + 1}`,
      createdAt: i + 1,
    }));

    // Fake provider returns a summary wrapped in <analysis>/<summary> tags (like CC)
    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['summarize'] },
      new FakeProvider({
        content: [{ type: 'text', text: '<analysis>thinking...</analysis>\n<summary>short summary</summary>' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );

    expect(result.layersApplied).toEqual(['summarize']);
    // First message is the compacted summary (user role)
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        role: 'user',
        compacted: true,
      }),
    );
    // Analysis block should be stripped, summary content kept
    const summaryContent = result.messages[0].content as string;
    expect(summaryContent).toContain('short summary');
    expect(summaryContent).not.toContain('<analysis>');
    expect(summaryContent).toContain('continued from a previous conversation');
    // No fake assistant ack message — recent messages come right after
    // Recent messages preserved
    expect(result.messages.slice(-3).map(m => m.content)).toEqual([
      'message 10',
      'message 11',
      'message 12',
    ]);
  });

  it('skips summarize when <= 10 messages', async () => {
    const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg ${i}`,
    }));

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['summarize'] },
      new FakeProvider(), // chat should NOT be called
    );

    expect(result.layersApplied).not.toContain('summarize');
    expect(result.messages).toHaveLength(8);
  });

  it('falls through when LLM summarize fails', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg ${i}`,
    }));

    const failProvider = new FakeProvider(); // no response → throws
    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['summarize'] },
      failProvider,
    );

    // Should NOT throw; messages unchanged
    expect(result.messages).toHaveLength(12);
    expect(result.layersApplied).not.toContain('summarize');
  });

  // ===== Forked Compact (cache sharing) =====
  it('forked compact passes main system prompt + tools to summarize call', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i + 1}`,
      createdAt: i + 1,
    }));

    // Capture what the provider receives
    let capturedRequest: ProviderRequest | null = null;
    const spyProvider: Provider = {
      type: 'anthropic',
      async chat(request: ProviderRequest) {
        capturedRequest = request;
        return {
          content: [{ type: 'text' as const, text: '<summary>forked summary</summary>' }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };

    const forkContext = {
      systemPrompt: ['You are a coding assistant.', 'Be concise.'],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } } },
        },
      ],
    };

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['summarize'] },
      spyProvider,
      forkContext,
    );

    // Verify forked compact used main system prompt instead of COMPACT_SYSTEM_PROMPT
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.systemPrompt).toEqual(['You are a coding assistant.', 'Be concise.']);
    // Verify tools were passed through
    expect(capturedRequest!.tools).toEqual(forkContext.tools);
    // Summary still works correctly
    expect(result.layersApplied).toEqual(['summarize']);
    expect((result.messages[0].content as string)).toContain('forked summary');
  });

  it('without forkContext, uses standalone COMPACT_SYSTEM_PROMPT', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i + 1}`,
      createdAt: i + 1,
    }));

    let capturedRequest: ProviderRequest | null = null;
    const spyProvider: Provider = {
      type: 'anthropic',
      async chat(request: ProviderRequest) {
        capturedRequest = request;
        return {
          content: [{ type: 'text' as const, text: '<summary>standalone summary</summary>' }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };

    await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['summarize'] },
      spyProvider,
      // no forkContext
    );

    // Without fork, should use COMPACT_SYSTEM_PROMPT (a single string)
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.systemPrompt).toHaveLength(1);
    expect(capturedRequest!.systemPrompt[0]).toContain('summarizing conversation');
    // No tools passed
    expect(capturedRequest!.tools).toBeUndefined();
  });

  // ===== Layer 6: trim_assistant =====
  it('trims long assistant text messages', async () => {
    const longText = 'x'.repeat(5000);
    const messages: Message[] = [
      { role: 'assistant', content: longText },
      { role: 'assistant', content: 'short reply' },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['trim_assistant'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['trim_assistant']);
    const trimmed = result.messages[0].content as string;
    expect(trimmed.length).toBeLessThan(longText.length);
    expect(trimmed).toContain('[...trimmed...]');
    expect(result.messages[0].compacted).toBe(true);
    // Short message untouched
    expect(result.messages[1].content).toBe('short reply');
  });

  it('does not trim assistant messages with array content', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(5000) }],
      },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['trim_assistant'] },
      new FakeProvider(),
    );

    // Layer doesn't touch array content, only string
    expect(result.layersApplied).not.toContain('trim_assistant');
  });

  // ===== Layer 7: truncate_oldest =====
  it('truncates oldest messages, keeping at least 6', async () => {
    const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['truncate_oldest'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['truncate_oldest']);
    // First two messages are the truncation markers
    expect(result.messages[0].content).toContain('older messages truncated');
    expect(result.messages[0].compacted).toBe(true);
    expect(result.messages[1].content).toBe('Understood, older context has been removed.');
    // Kept ~30% = 9 messages + 2 markers = 11
    expect(result.messages.length).toBeLessThan(30);
    expect(result.messages.length).toBeGreaterThanOrEqual(8);
    // Last message is preserved
    expect(result.messages[result.messages.length - 1].content).toBe('message 29');
  });

  it('does not truncate when message count is small', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['truncate_oldest'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).not.toContain('truncate_oldest');
    expect(result.messages).toHaveLength(2);
  });

  // ===== Pipeline behavior =====
  it('stops applying layers once under threshold', async () => {
    // Small messages that fit in a generous threshold
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const result = await compact(
      messages,
      { contextWindow: 200_000, threshold: 200_000, enabledLayers: ['clear_thinking', 'truncate_tool_results'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual([]);
    expect(result.tokensFreed).toBe(0);
  });

  it('respects enabledLayers filter', async () => {
    const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));

    // Only enable truncate_oldest, disable everything else
    const result = await compact(
      messages,
      { ...FORCE_COMPACT, enabledLayers: ['truncate_oldest'] },
      new FakeProvider(),
    );

    expect(result.layersApplied).toEqual(['truncate_oldest']);
  });

  // ===== estimateTokens =====
  it('estimates tokens for various content types', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello world' }, // 11 chars → ~3 tokens
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'response text here' }, // 18 chars → ~5 tokens
          { type: 'tool_use', id: 't1', name: 'read', input: { path: '/a.ts' } }, // JSON ~20 chars → ~5 tokens
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'file contents' }, // 13 chars → ~4 tokens
        ],
      },
    ];

    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    // Rough check: should be reasonable for the content size
    expect(tokens).toBeLessThan(100);
  });
});
