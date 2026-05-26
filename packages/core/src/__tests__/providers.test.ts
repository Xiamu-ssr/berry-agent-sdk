import { describe, expect, it } from 'vitest';

import { extractContextWindowFromError } from '../agent-helpers/provider.js';
import { normalizeOpenAIBaseUrl } from '../providers/openai.js';
import {
  buildAnthropicMessages,
  buildAnthropicSystemBlocks,
} from '../providers/anthropic/messages.js';
import {
  extractAnthropicUsage,
  parseAnthropicResponseContent,
  reconcileAnthropicStopReason,
} from '../providers/anthropic/response.js';
import { buildOpenAIMessages } from '../providers/openai/messages.js';
import {
  extractOpenAIUsage,
  parseOpenAIResponse,
} from '../providers/openai/response.js';
import type { AnnotationContent, Message } from '../index.js';

const annotationBlock: AnnotationContent = {
  type: 'annotation',
  body: 'The selected button copy should be shorter.',
  source: { url: 'https://example.test/settings', title: 'Settings' },
  rect: { x: 24, y: 48, width: 160, height: 44 },
  viewport: { width: 1024, height: 768 },
  image: { data: 'aW1hZ2U=', mediaType: 'image/png', width: 192, height: 76 },
};

describe('AnthropicProvider adapters', () => {
  it('builds cache-aware system blocks and Anthropic messages', () => {
    const systemBlocks = buildAnthropicSystemBlocks([
      { text: 'static rules', cache: 'stable' },
      { text: 'dynamic context', cache: 'dynamic' },
    ]);

    // Anthropic should cache both the stable boundary and the full prompt boundary.
    expect(systemBlocks).toEqual([
      {
        type: 'text',
        text: 'static rules',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'dynamic context',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden', signature: 'sig' },
          { type: 'text', text: 'let me inspect' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_1', content: 'file contents', isError: false },
        ],
      },
    ];

    const wireMessages = buildAnthropicMessages(messages, 2);

    expect(wireMessages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'hello',
        },
      ],
    });

    expect(wireMessages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'hidden',
          signature: 'sig',
        },
        {
          type: 'text',
          text: 'let me inspect',
        },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_file',
          input: { path: 'a.ts' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    });

    expect(wireMessages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'file contents',
          is_error: false,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });

  it('reconciles stop_reason when content has tool_use but API says end_turn', () => {
    // Simulate a proxy returning end_turn with tool_use content
    const content = [
      { type: 'text' as const, text: 'Let me check.' },
      { type: 'tool_use' as const, id: 'toolu_1', name: 'read_file', input: { path: '/tmp' } },
    ];
    const result = reconcileAnthropicStopReason('end_turn', content);
    expect(result).toBe('tool_use');

    // When no tool_use blocks, keep original stop_reason
    const noTools = [{ type: 'text' as const, text: 'Done.' }];
    expect(reconcileAnthropicStopReason('end_turn', noTools)).toBe('end_turn');

    // When already tool_use, keep it
    expect(reconcileAnthropicStopReason('tool_use', content)).toBe('tool_use');
  });

  it('parses Anthropic response blocks into Berry content', () => {
    const parsed = parseAnthropicResponseContent([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'foo' } },
      { type: 'thinking', thinking: 'considering', signature: 'sig' },
    ]);

    expect(parsed).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'foo' } },
      { type: 'thinking', thinking: 'considering', signature: 'sig' },
    ]);
  });

  it('drops unsigned thinking blocks at the Anthropic boundary', () => {
    const wireMessages = buildAnthropicMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'unsigned' },
          { type: 'text', text: 'visible reply' },
        ],
      },
    ] satisfies Message[], 2);

    expect(wireMessages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'visible reply', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('converts human annotation blocks to text plus image for Anthropic', () => {
    const wireMessages = buildAnthropicMessages([
      { role: 'user', content: [annotationBlock] },
    ] satisfies Message[], 2);

    expect(wireMessages[0]).toEqual({
      role: 'user',
      content: [
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Human browser annotation:'),
        }),
        expect.objectContaining({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1hZ2U=',
          },
          cache_control: { type: 'ephemeral' },
        }),
      ],
    });
  });

  it('sanitizes OpenAI-style empty history before sending it to Anthropic', () => {
    const wireMessages = buildAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '   ' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'thinking', thinking: 'provider-private reasoning without signature' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', content: '' },
        ],
      },
    ] satisfies Message[], 2);

    expect(wireMessages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '(empty message)' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '(unsigned thinking omitted)' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '(empty tool result)',
            is_error: false,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);

    for (const message of wireMessages) {
      for (const block of message.content as Array<{ type: string; text?: string; content?: unknown }>) {
        if (block.type === 'text') {
          expect(block.text?.trim()).not.toBe('');
        }
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          expect(block.content.trim()).not.toBe('');
        }
      }
    }
  });

  it('deduplicates Anthropic system cache breakpoints when the final block is stable', () => {
    const systemBlocks = buildAnthropicSystemBlocks([
      { text: 'shared rules', cache: 'stable' },
      { text: 'more shared rules', cache: 'stable' },
    ]);

    expect(systemBlocks).toEqual([
      {
        type: 'text',
        text: 'shared rules',
      },
      {
        type: 'text',
        text: 'more shared rules',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('provider error helpers', () => {
  it('extracts provider-reported context windows from prompt-too-long errors', () => {
    expect(extractContextWindowFromError(new Error('This model supports at most 100000 tokens, but got 150001.'))).toBe(100_000);
    expect(extractContextWindowFromError({ error: { message: 'input length 250,000 > 100,000 maximum tokens' } })).toBe(100_000);
    expect(extractContextWindowFromError(new Error('maximum context length is 128,000 tokens'))).toBe(128_000);
    expect(extractContextWindowFromError(new Error('rate limit'))).toBeUndefined();
  });
});

describe('OpenAIProvider adapters', () => {
  it('normalizes bare gateway origins to /v1', () => {
    expect(normalizeOpenAIBaseUrl('https://ai.yescode.cloud')).toBe('https://ai.yescode.cloud/v1');
    expect(normalizeOpenAIBaseUrl('https://api.example.test/v2')).toBe('https://api.example.test/v2');
  });

  it('builds OpenAI wire messages with tool_calls and tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', content: 'contents' },
          { type: 'text', text: 'extra note' },
        ],
      },
    ];

    const wireMessages = buildOpenAIMessages([
      { text: 'rules', cache: 'stable' },
      { text: 'context', cache: 'dynamic' },
    ], messages);

    expect(wireMessages[0]).toEqual({
      role: 'system',
      content: 'rules\n\ncontext',
    });

    expect(wireMessages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(wireMessages[2]).toEqual({
      role: 'assistant',
      content: 'checking',
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'a.ts' }),
          },
        },
      ],
    });
    expect(wireMessages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'contents',
    });
    expect(wireMessages[4]).toEqual({ role: 'user', content: 'extra note' });
  });

  it('converts human annotation blocks to text plus image for OpenAI', () => {
    const wireMessages = buildOpenAIMessages([], [
      { role: 'user', content: [annotationBlock] },
    ] satisfies Message[]);

    expect(wireMessages).toEqual([
      {
        role: 'user',
        content: expect.stringContaining('Human browser annotation:'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
          },
        ],
      },
    ]);
  });

  it('throws on empty OpenAI assistant messages', () => {
    expect(() => parseOpenAIResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
      usage: {},
    } as any, 'https://ai.yescode.cloud/v1')).toThrow(/empty assistant message/i);
  });

  it('parses OpenAI responses into Berry content blocks', () => {
    const parsed = parseOpenAIResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'I will inspect that file.',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'grep',
                  arguments: '{"pattern":"Berry"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    } as any);

    expect(parsed).toEqual({
      content: [
        { type: 'text', text: 'I will inspect that file.' },
        { type: 'tool_use', id: 'call_2', name: 'grep', input: { pattern: 'Berry' } },
      ],
      stopReason: 'tool_use',
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
      },
      rawUsage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    });
  });

  it('keeps non-object OpenAI tool arguments as raw boundary data', () => {
    const parsed = parseOpenAIResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_array',
                type: 'function',
                function: {
                  name: 'bad_args',
                  arguments: '["not","an","object"]',
                },
              },
            ],
          },
        },
      ],
      usage: {},
    } as any);

    expect(parsed.content).toEqual([
      { type: 'tool_use', id: 'call_array', name: 'bad_args', input: { _raw: '["not","an","object"]' } },
    ]);
  });

  it('keeps non-object Anthropic tool inputs as raw boundary data', () => {
    const parsed = parseAnthropicResponseContent([
      { type: 'tool_use', id: 'toolu_bad', name: 'bad_args', input: ['not', 'an', 'object'] },
    ] as any);

    expect(parsed).toEqual([
      { type: 'tool_use', id: 'toolu_bad', name: 'bad_args', input: { _raw: ['not', 'an', 'object'] } },
    ]);
  });
});

// ============================================================
// TokenUsage semantic contract (cross-provider)
//
// Single source of truth: `inputTokens` is the *total* input billed for this
// call (cache included). `cacheReadTokens` / `cacheWriteTokens` are subsets,
// disclosed for analytics only and NEVER additive at any upper layer.
//
// Provider implementations are responsible for normalizing wire formats:
//   - Anthropic wire `input_tokens` excludes cache  → we add it back.
//   - OpenAI    wire `prompt_tokens` already includes cache → we pass through.
//
// Without this contract, an upper layer (agent / claw server / front-end)
// that re-applies an `if (anthropic) inputTokens + cacheRead + cacheWrite`
// pattern double-counts the cached portion and inflates context display ~2x.
// ============================================================
describe('TokenUsage semantic contract', () => {
  it('Anthropic provider synthesizes inputTokens to be cache-inclusive', () => {
    // Real fixture from a production session (ses_1779175050991_rt4xpf, L23):
    // wire reported input_tokens=19308 with cache_read_input_tokens=17142.
    // Anthropic semantics: input_tokens excludes cache, so the true total
    // input the model saw is 19308 + 17142 = 36450.
    const usage = extractAnthropicUsage({
      input_tokens: 19308,
      output_tokens: 100,
      cache_read_input_tokens: 17142,
      cache_creation_input_tokens: 0,
    });

    expect(usage.inputTokens).toBe(36450);
    expect(usage.cacheReadTokens).toBe(17142);
    expect(usage.cacheWriteTokens).toBe(0);
    expect(usage.outputTokens).toBe(100);
  });

  it('Anthropic provider also folds cache_creation into the total', () => {
    const usage = extractAnthropicUsage({
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
    });

    expect(usage.inputTokens).toBe(8000); // 1000 + 5000 + 2000
    expect(usage.cacheReadTokens).toBe(5000);
    expect(usage.cacheWriteTokens).toBe(2000);
  });

  it('OpenAI provider passes prompt_tokens through (cache already included)', () => {
    // OpenAI semantics: prompt_tokens already includes cached_tokens.
    // The provider must NOT add or subtract — just pass through 19308
    // and disclose 17142 as a subset.
    const usage = extractOpenAIUsage({
      prompt_tokens: 19308,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 17142 },
    });

    expect(usage.inputTokens).toBe(19308); // unchanged
    expect(usage.cacheReadTokens).toBe(17142);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('Both providers report identical inputTokens for the same logical call', () => {
    // Same logical call routed through different wire formats must yield
    // the same inputTokens (the model sees the same context either way).
    // This pins the contract that lets agent.ts use a single assignment
    // without per-provider arithmetic.
    const TOTAL = 50_000;
    const CACHED = 40_000;

    const a = extractAnthropicUsage({
      input_tokens: TOTAL - CACHED, // anthropic wire excludes cache
      output_tokens: 0,
      cache_read_input_tokens: CACHED,
      cache_creation_input_tokens: 0,
    });
    const o = extractOpenAIUsage({
      prompt_tokens: TOTAL, // openai wire includes cache
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: CACHED },
    });

    expect(a.inputTokens).toBe(TOTAL);
    expect(o.inputTokens).toBe(TOTAL);
    expect(a.cacheReadTokens).toBe(CACHED);
    expect(o.cacheReadTokens).toBe(CACHED);
  });
});
