import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ContentBlock } from '../../content-types.js';
import type { ProviderResponse, TokenUsage } from '../../provider-types.js';
import { parseProviderToolInputJSON } from '../tool-input.js';

export interface OpenAIStreamAccumulator {
  textParts: string[];
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage: TokenUsage;
  stopReason: ProviderResponse['stopReason'];
  lastChunkId?: string;
  lastChunkModel?: string;
  rawUsageRaw: Record<string, unknown>;
  chunkCount: number;
}

export function createOpenAIStreamAccumulator(): OpenAIStreamAccumulator {
  return {
    textParts: [],
    toolCalls: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
    rawUsageRaw: {},
    chunkCount: 0,
  };
}

export function accumulateOpenAIStreamChunk(
  acc: OpenAIStreamAccumulator,
  chunk: ChatCompletionChunk,
): string[] {
  const textDeltas: string[] = [];
  acc.chunkCount++;
  acc.lastChunkId = chunk.id;
  acc.lastChunkModel = chunk.model;

  if (chunk.usage) {
    acc.usage = extractOpenAIUsage(chunk.usage);
    acc.rawUsageRaw = chunk.usage as unknown as Record<string, unknown>;
  }

  const choice = chunk.choices[0];
  if (!choice) return textDeltas;

  if (choice.finish_reason) {
    acc.stopReason = mapOpenAIStopReason(choice.finish_reason);
  }

  const delta = choice.delta;
  if (delta.content) {
    acc.textParts.push(delta.content);
    textDeltas.push(delta.content);
  }

  for (const toolCallDelta of delta.tool_calls ?? []) {
    const current = acc.toolCalls.get(toolCallDelta.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };

    if (toolCallDelta.id) current.id = toolCallDelta.id;
    if (toolCallDelta.function?.name) current.name += toolCallDelta.function.name;
    if (toolCallDelta.function?.arguments) current.arguments += toolCallDelta.function.arguments;

    acc.toolCalls.set(toolCallDelta.index, current);
  }

  return textDeltas;
}

export function finalizeOpenAIStreamResponse(
  acc: OpenAIStreamAccumulator,
  baseUrl?: string,
): ProviderResponse {
  if (acc.chunkCount === 0) {
    throw new Error(
      `OpenAI-compatible stream returned 0 chunks. This usually means the baseUrl is wrong or the gateway is serving HTML instead of /v1 API responses. baseUrl=${baseUrl ?? '(default)'}`,
    );
  }

  const content: ContentBlock[] = [];
  const text = acc.textParts.join('');
  if (text) content.push({ type: 'text', text });

  const builtToolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
  for (const [, toolCall] of [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || `tool_${Math.random().toString(36).slice(2, 8)}`,
      name: toolCall.name,
      input: parseProviderToolInputJSON(toolCall.arguments),
    });
    builtToolCalls.push({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    });
  }

  assertNonEmptyOpenAIContent(content, baseUrl);

  const rawResponse: Record<string, unknown> = {
    id: acc.lastChunkId,
    model: acc.lastChunkModel,
    object: 'chat.completion',
    usage: acc.rawUsageRaw,
    choices: [{
      finish_reason: acc.stopReason === 'tool_use' ? 'tool_calls' : acc.stopReason === 'max_tokens' ? 'length' : 'stop',
      message: {
        role: 'assistant',
        content: text || null,
        ...(builtToolCalls.length > 0 ? { tool_calls: builtToolCalls } : {}),
      },
    }],
  };

  return {
    content,
    stopReason: acc.stopReason,
    usage: acc.usage,
    rawUsage: acc.rawUsageRaw,
    rawResponse,
  };
}

export function parseOpenAIResponse(response: OpenAI.ChatCompletion, baseUrl?: string): ProviderResponse {
  const choice = response.choices[0];
  if (!choice) {
    return {
      content: [{ type: 'text', text: '(no response)' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const content: ContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (!('function' in tc) || !tc.function) continue;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseProviderToolInputJSON(tc.function.arguments),
      });
    }
  }

  assertNonEmptyOpenAIContent(content, baseUrl);

  return {
    content,
    stopReason: mapOpenAIStopReason(choice.finish_reason),
    usage: extractOpenAIUsage(response.usage),
    rawUsage: response.usage as unknown as Record<string, unknown>,
  };
}

export function mapOpenAIStopReason(reason: string | null): ProviderResponse['stopReason'] {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

export function extractOpenAIUsage(usage?: OpenAI.CompletionUsage | null): TokenUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };

  const details = (usage as unknown as Record<string, unknown>)?.prompt_tokens_details as { cached_tokens?: number } | undefined;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

function assertNonEmptyOpenAIContent(content: ContentBlock[], baseUrl?: string): void {
  if (content.length > 0) return;
  throw new Error(
    `OpenAI-compatible endpoint returned an empty assistant message (no content, no tool_calls). This usually indicates an incompatible gateway or wrong baseUrl. baseUrl=${baseUrl ?? '(default)'}`,
  );
}
