// ============================================================
// Berry Agent SDK — Anthropic Provider
// ============================================================
// Runtime wrapper around @anthropic-ai/sdk. Message construction and
// response parsing live in ./anthropic/* so protocol-specific rules stay
// testable and do not leak through the provider runtime.

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  TokenUsage,
} from '../provider-types.js';
import type {
  ContentBlock,
  TextContent,
  ThinkingContent,
} from '../content-types.js';
import { DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } from '../constants.js';
import { withRetry } from '../utils/retry.js';
import {
  buildAnthropicMessages,
  buildAnthropicSystemBlocks,
  buildAnthropicTools,
} from './anthropic/messages.js';
import {
  extractAnthropicUsage,
  mapAnthropicStopReason,
  parseAnthropicResponseContent,
  parseAnthropicStreamStartBlock,
  reconcileAnthropicStopReason,
} from './anthropic/response.js';
import { parseProviderToolInputJSON } from './tool-input.js';

// Extended Anthropic SDK types for beta features (thinking, etc.)
interface ThinkingDelta { type: 'thinking_delta'; thinking: string }
interface SignatureDelta { type: 'signature_delta'; signature: string }

const ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4;
const ANTHROPIC_MAX_MESSAGE_CACHE_BREAKPOINTS = 2;
const ANTHROPIC_EMPTY_STREAM_RESPONSE_TEXT = '(empty response)';

export class AnthropicProvider implements Provider {
  readonly type = 'anthropic' as const;
  private client: Anthropic;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0, // We handle retries ourselves
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const params = this.buildParams(request);
    const response = await withRetry(
      () => this.client.messages.create(params as unknown as MessageCreateParamsNonStreaming, { signal: request.signal }),
      request.signal,
    );

    const content = parseAnthropicResponseContent(response.content);
    const rawStopReason = mapAnthropicStopReason(response.stop_reason);
    return {
      content,
      stopReason: reconcileAnthropicStopReason(rawStopReason, content),
      usage: extractAnthropicUsage(response.usage),
      rawUsage: response.usage as unknown as Record<string, unknown>,
      rawRequest: params as Record<string, unknown>,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const params = this.buildStreamParams(request);
    const rawRequest = this.buildParams(request) as Record<string, unknown>;
    const stream = await withRetry(
      () => this.client.messages.create(params as unknown as MessageCreateParamsStreaming, { signal: request.signal }),
      request.signal,
    ) as AsyncIterable<RawMessageStreamEvent>;

    const content: Array<ContentBlock | undefined> = [];
    const toolInputJson = new Map<number, string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';
    let rawMessageId: string | undefined;
    let rawMessageModel: string | undefined;
    let rawMessageType: string | undefined;
    let rawUsageRaw: Record<string, unknown> = {};

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          usage = extractAnthropicUsage(event.message.usage);
          rawUsageRaw = event.message.usage as unknown as Record<string, unknown>;
          rawMessageId = event.message.id;
          rawMessageModel = event.message.model;
          rawMessageType = event.message.type;
          break;
        }
        case 'content_block_start': {
          const block = parseAnthropicStreamStartBlock(event.content_block);
          content[event.index] = block;

          if (block?.type === 'text' && block.text) {
            yield { type: 'text_delta', text: block.text };
          }
          if (block?.type === 'thinking' && block.thinking) {
            yield { type: 'thinking_delta', thinking: block.thinking };
          }
          break;
        }
        case 'content_block_delta': {
          const block = content[event.index];
          const delta = event.delta;

          if (delta.type === 'text_delta') {
            const text = delta.text ?? '';
            const target = block && block.type === 'text'
              ? block
              : ({ type: 'text', text: '' } satisfies TextContent);
            target.text += text;
            content[event.index] = target;
            if (text) {
              yield { type: 'text_delta', text };
            }
          } else if (delta.type === 'thinking_delta') {
            const thinking = (delta as unknown as ThinkingDelta).thinking ?? '';
            const target = block && block.type === 'thinking'
              ? block
              : ({ type: 'thinking', thinking: '' } satisfies ThinkingContent);
            target.thinking += thinking;
            content[event.index] = target;
            if (thinking) {
              yield { type: 'thinking_delta', thinking };
            }
          } else if (delta.type === 'signature_delta') {
            const signature = (delta as unknown as SignatureDelta).signature ?? '';
            const target = block && block.type === 'thinking'
              ? block
              : ({ type: 'thinking', thinking: '' } satisfies ThinkingContent);
            target.signature = `${target.signature ?? ''}${signature}`;
            content[event.index] = target;
          } else if (delta.type === 'input_json_delta') {
            toolInputJson.set(event.index, (toolInputJson.get(event.index) ?? '') + delta.partial_json);
          }
          break;
        }
        case 'content_block_stop': {
          const block = content[event.index];
          const partialJson = toolInputJson.get(event.index);
          if (block?.type === 'tool_use' && partialJson) {
            block.input = parseProviderToolInputJSON(partialJson);
          }
          break;
        }
        case 'message_delta': {
          usage = extractAnthropicUsage(event.usage);
          rawUsageRaw = event.usage as unknown as Record<string, unknown>;
          stopReason = mapAnthropicStopReason(event.delta.stop_reason);
          break;
        }
        case 'message_stop':
          break;
        default:
          break;
      }
    }

    const finalContent = content.filter((block): block is ContentBlock => block !== undefined);
    const safeContent = finalContent.length > 0
      ? finalContent
      : [{ type: 'text' as const, text: ANTHROPIC_EMPTY_STREAM_RESPONSE_TEXT }];
    const reconciledStopReason = reconcileAnthropicStopReason(stopReason, safeContent);

    const rawResponse: Record<string, unknown> = {
      id: rawMessageId,
      type: rawMessageType,
      model: rawMessageModel,
      stop_reason: reconciledStopReason === 'tool_use' ? 'tool_use' : reconciledStopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      usage: rawUsageRaw,
      content: safeContent,
    };

    yield {
      type: 'response',
      response: {
        content: safeContent,
        stopReason: reconciledStopReason,
        usage,
        rawUsage: rawUsageRaw,
        rawRequest,
        rawResponse,
      },
    };
  }

  // ===== Params =====

  private buildParams(request: ProviderRequest): Record<string, unknown> {
    const system = buildAnthropicSystemBlocks(request.systemPrompt);
    const remainingCacheBreakpoints = Math.max(
      0,
      ANTHROPIC_CACHE_BREAKPOINT_BUDGET - countCacheBreakpoints(system),
    );
    const messages = buildAnthropicMessages(
      request.messages,
      Math.min(ANTHROPIC_MAX_MESSAGE_CACHE_BREAKPOINTS, remainingCacheBreakpoints),
    );
    const tools = (request.tools || request.responseFormat)
      ? buildAnthropicTools(request.tools ?? [], request.responseFormat)
      : undefined;

    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const params: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const thinkingBudget = this.resolveThinkingBudget(maxTokens);
    if (thinkingBudget && thinkingBudget > 0) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
      params.max_tokens = Math.max(maxTokens, thinkingBudget + 1);
    }

    return params;
  }

  private resolveThinkingBudget(maxTokens: number): number | undefined {
    if (this.config.thinkingBudget !== undefined) {
      return this.config.thinkingBudget > 0 ? this.config.thinkingBudget : undefined;
    }
    const effort = this.config.reasoningEffort;
    if (!effort || effort === 'none') return undefined;
    const map: Record<string, number> = {
      low: 4096,
      medium: 16000,
      high: 32000,
      max: 64000,
      xhigh: 64000,
    };
    const budget = map[effort] ?? 16000;
    return Math.min(budget, maxTokens - 1);
  }

  private buildStreamParams(request: ProviderRequest): Record<string, unknown> {
    return {
      ...this.buildParams(request),
      stream: true,
    };
  }
}

function countCacheBreakpoints(blocks: Array<{ cache_control?: unknown }>): number {
  return blocks.reduce((count, block) => count + (block.cache_control ? 1 : 0), 0);
}
