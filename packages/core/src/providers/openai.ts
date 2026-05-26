// ============================================================
// Berry Agent SDK — OpenAI Compatible Provider
// ============================================================
// Covers OpenAI and OpenAI-compatible endpoints. Provider runtime stays here;
// wire message construction and response parsing are split into ./openai/*.

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from '../provider-types.js';
import { DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } from '../constants.js';
import { withRetry } from '../utils/retry.js';
import {
  buildOpenAIMessages,
  buildOpenAITools,
} from './openai/messages.js';
import {
  accumulateOpenAIStreamChunk,
  createOpenAIStreamAccumulator,
  finalizeOpenAIStreamResponse,
  parseOpenAIResponse,
} from './openai/response.js';

export class OpenAIProvider implements Provider {
  readonly type = 'openai' as const;
  private client: OpenAI;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      // Many OpenAI-compatible gateways require `/v1` but users often paste the
      // site origin (e.g. https://ai.yescode.cloud). Normalize the common case
      // so the provider doesn't silently talk to an HTML landing page.
      baseURL: normalizeOpenAIBaseUrl(config.baseUrl),
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const params = this.buildParams(request);
    const response = await withRetry(
      () => this.client.chat.completions.create(params, { signal: request.signal }),
      request.signal,
    );
    assertValidOpenAIResponse(response, this.config.baseUrl);
    const result = parseOpenAIResponse(response, this.config.baseUrl);
    result.rawRequest = params as unknown as Record<string, unknown>;
    result.rawResponse = response as unknown as Record<string, unknown>;
    return result;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const params = this.buildStreamParams(request);
    const rawRequest = this.buildParams(request) as unknown as Record<string, unknown>;
    const stream = await withRetry(
      () => this.client.chat.completions.create(params, { signal: request.signal }),
      request.signal,
    ) as AsyncIterable<ChatCompletionChunk>;

    const acc = createOpenAIStreamAccumulator();
    for await (const chunk of stream) {
      for (const text of accumulateOpenAIStreamChunk(acc, chunk)) {
        yield { type: 'text_delta', text };
      }
    }

    const response = finalizeOpenAIStreamResponse(acc, this.config.baseUrl);
    response.rawRequest = rawRequest;

    yield { type: 'response', response };
  }

  // ===== Params =====

  private buildParams(request: ProviderRequest): OpenAI.ChatCompletionCreateParamsNonStreaming {
    const messages = buildOpenAIMessages(request.systemPrompt, request.messages);
    const tools = request.tools ? buildOpenAITools(request.tools) : undefined;

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const reasoningEffort = this.resolveReasoningEffort();
    if (reasoningEffort) {
      ((params as unknown) as Record<string, unknown>).reasoning_effort = reasoningEffort;
    }

    if (request.responseFormat) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          ...(request.responseFormat.description ? { description: request.responseFormat.description } : {}),
          schema: request.responseFormat.schema,
          strict: true,
        },
      } as unknown as OpenAI.ChatCompletionCreateParams['response_format'];
    }

    return params;
  }

  private buildStreamParams(request: ProviderRequest): OpenAI.ChatCompletionCreateParamsStreaming {
    const messages = buildOpenAIMessages(request.systemPrompt, request.messages);
    const tools = request.tools ? buildOpenAITools(request.tools) : undefined;

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const reasoningEffort = this.resolveReasoningEffort();
    if (reasoningEffort) {
      ((params as unknown) as Record<string, unknown>).reasoning_effort = reasoningEffort;
    }

    if (request.responseFormat) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          ...(request.responseFormat.description ? { description: request.responseFormat.description } : {}),
          schema: request.responseFormat.schema,
          strict: true,
        },
      } as unknown as OpenAI.ChatCompletionCreateParams['response_format'];
    }

    return params;
  }

  private resolveReasoningEffort(): string | undefined {
    const effort = this.config.reasoningEffort;
    if (!effort || effort === 'none') return undefined;
    const map: Record<string, string> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'xhigh',
      xhigh: 'xhigh',
    };
    return map[effort];
  }
}

export function normalizeOpenAIBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+(?:\/)?$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function assertValidOpenAIResponse(response: unknown, baseUrl?: string): asserts response is OpenAI.ChatCompletion {
  const obj = response as { choices?: unknown } | null;
  if (obj && Array.isArray(obj.choices)) return;

  throw new Error(
    `OpenAI-compatible endpoint returned a non-ChatCompletion response. This usually means the baseUrl is wrong or missing /v1. baseUrl=${baseUrl ?? '(default)'}`,
  );
}
