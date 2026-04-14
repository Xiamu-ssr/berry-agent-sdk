import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import type { Message } from '../types.js';

describe('AnthropicProvider adapters', () => {
  it('builds cache-aware system blocks and Anthropic messages', () => {
    const provider = new AnthropicProvider({
      type: 'anthropic',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    });

    const systemBlocks = (provider as any).buildSystemBlocks([
      'static rules',
      'dynamic context',
    ]);

    // Only the LAST system block gets cache_control (to stay within 4-block limit)
    expect(systemBlocks).toEqual([
      {
        type: 'text',
        text: 'static rules',
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
          { type: 'thinking', thinking: 'hidden' },
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

    const wireMessages = (provider as any).buildMessages(messages);

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

  it('parses Anthropic response blocks into Berry content', () => {
    const provider = new AnthropicProvider({
      type: 'anthropic',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    });

    const parsed = (provider as any).parseResponseContent([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'foo' } },
      { type: 'thinking', thinking: 'considering', signature: 'sig' },
    ]);

    expect(parsed).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_2', name: 'grep', input: { pattern: 'foo' } },
      { type: 'thinking', thinking: 'considering' },
    ]);
  });
});

describe('OpenAIProvider adapters', () => {
  it('builds OpenAI wire messages with tool_calls and tool results', () => {
    const provider = new OpenAIProvider({
      type: 'openai',
      apiKey: 'test',
      model: 'gpt-5.4',
    });

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

    const wireMessages = (provider as any).buildMessages(['rules', 'context'], messages);

    expect(wireMessages[0]).toEqual({
      role: 'system',
      content: 'rules\n\ncontext',
    });

    expect(wireMessages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(wireMessages[2]).toEqual({
      role: 'assistant',
      content: 'checking',
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

  it('parses OpenAI responses into Berry content blocks', () => {
    const provider = new OpenAIProvider({
      type: 'openai',
      apiKey: 'test',
      model: 'gpt-5.4',
    });

    const parsed = (provider as any).parseResponse({
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
    });

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
});
