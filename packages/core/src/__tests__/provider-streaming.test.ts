import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import type { ProviderRequest, ProviderStreamEvent } from '../types.js';

async function collect(iterable: AsyncIterable<ProviderStreamEvent>) {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const request: ProviderRequest = {
  systemPrompt: ['You are helpful.'],
  messages: [{ role: 'user', content: 'hi' }],
};

describe('provider streaming', () => {
  it('AnthropicProvider.stream reconstructs text, thinking, tool use, usage, and stopReason', async () => {
    const provider = new AnthropicProvider({
      type: 'anthropic',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    });

    (provider as any).client = {
      messages: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 11,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
            };
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hel' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'lo' },
            };
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'thinking', thinking: '' },
            };
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'thinking_delta', thinking: 'hmm' },
            };
            yield {
              type: 'content_block_start',
              index: 2,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
            };
            yield {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
            };
            yield { type: 'content_block_stop', index: 2 };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: {
                input_tokens: 11,
                output_tokens: 7,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 9,
              },
            };
            yield { type: 'message_stop' };
          },
        }),
      },
    };

    const events = await collect(provider.stream!(request));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'thinking_delta', thinking: 'hmm' },
      expect.objectContaining({
        type: 'response',
        response: expect.objectContaining({
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
          ],
          stopReason: 'tool_use',
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            cacheWriteTokens: 2,
            cacheReadTokens: 9,
          },
          // rawRequest and rawResponse are now populated (tested separately)
          rawRequest: expect.objectContaining({ model: 'claude-sonnet-4-20250514' }),
          rawResponse: expect.objectContaining({ stop_reason: 'tool_use' }),
        }),
      }),
    ]);
  });

  it('OpenAIProvider.stream reconstructs text, tool calls, usage, and stopReason', async () => {
    const provider = new OpenAIProvider({
      type: 'openai',
      apiKey: 'test',
      model: 'gpt-5.4',
    });

    (provider as any).client = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                choices: [
                  {
                    index: 0,
                    finish_reason: null,
                    delta: { content: 'Hel' },
                  },
                ],
                usage: null,
              };
              yield {
                choices: [
                  {
                    index: 0,
                    finish_reason: null,
                    delta: {
                      content: 'lo',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: {
                            name: 'read_file',
                            arguments: '{"path":"a',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: null,
              };
              yield {
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments: '.ts"}',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 9,
                  prompt_tokens_details: { cached_tokens: 4 },
                },
              };
            },
          }),
        },
      },
    };

    const events = await collect(provider.stream!(request));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      expect.objectContaining({
        type: 'response',
        response: expect.objectContaining({
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
          ],
          stopReason: 'tool_use',
          usage: {
            inputTokens: 20,
            outputTokens: 9,
            cacheReadTokens: 4,
            cacheWriteTokens: 0,
          },
          // rawRequest and rawResponse are now populated (tested separately)
          rawRequest: expect.objectContaining({ model: 'gpt-5.4' }),
          rawResponse: expect.objectContaining({ choices: expect.any(Array) }),
        }),
      }),
    ]);
  });
});
