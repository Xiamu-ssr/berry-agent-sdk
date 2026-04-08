// ============================================================
// Berry Agent SDK — OpenAI Compatible Provider
// ============================================================
// Covers: OpenAI, DeepSeek, Qwen, Mistral, Groq, Together,
// Ollama, and any OpenAI-compatible endpoint.
//
// Key differences from Anthropic:
// - Cache is AUTOMATIC (no breakpoints). Just keep prefix stable.
// - tool_calls[] on assistant message, not content blocks
// - role:"tool" messages for results, not user content blocks
// - arguments is JSON string, not object
// - No thinking blocks

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  Message,
  ContentBlock,
  ToolDefinition,
  TokenUsage,
  TextContent,
  ToolUseContent,
  ToolResultContent,
} from '../types.js';

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

export class OpenAIProvider implements Provider {
  readonly type = 'openai' as const;
  private client: OpenAI;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: 120_000,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.callWithRetry(this.buildParams(request), request.signal);
    return this.parseResponse(response);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const stream = await this.callStreamWithRetry(this.buildStreamParams(request), request.signal);

    const textParts: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = this.extractUsage(chunk.usage);
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        stopReason = this.mapStopReason(choice.finish_reason);
      }

      const delta = choice.delta;
      if (delta.content) {
        textParts.push(delta.content);
        yield { type: 'text_delta', text: delta.content };
      }

      for (const toolCallDelta of delta.tool_calls ?? []) {
        const current = toolCalls.get(toolCallDelta.index) ?? {
          id: '',
          name: '',
          arguments: '',
        };

        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          current.name += toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          current.arguments += toolCallDelta.function.arguments;
        }

        toolCalls.set(toolCallDelta.index, current);
      }
    }

    const content: ContentBlock[] = [];
    const text = textParts.join('');

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const [, toolCall] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: 'tool_use',
        id: toolCall.id || `tool_${Math.random().toString(36).slice(2, 8)}`,
        name: toolCall.name,
        input: this.parseToolArguments(toolCall.arguments),
      });
    }

    yield {
      type: 'response',
      response: {
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        stopReason,
        usage,
      },
    };
  }

  // ===== Params =====

  private buildParams(request: ProviderRequest): OpenAI.ChatCompletionCreateParamsNonStreaming {
    const messages = this.buildMessages(request.systemPrompt, request.messages);
    const tools = request.tools ? this.buildTools(request.tools) : undefined;

    return {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? 16_384,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };
  }

  private buildStreamParams(request: ProviderRequest): OpenAI.ChatCompletionCreateParamsStreaming {
    const messages = this.buildMessages(request.systemPrompt, request.messages);
    const tools = request.tools ? this.buildTools(request.tools) : undefined;

    return {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? 16_384,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
    };
  }

  // ===== Message Building =====

  private buildMessages(
    systemPrompt: string[],
    messages: Message[],
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    const systemText = systemPrompt.filter(Boolean).join('\n\n');
    if (systemText) {
      result.push({ role: 'system', content: systemText });
    }

    for (const msg of messages) {
      const converted = this.convertMessage(msg);
      result.push(...converted);
    }

    return result;
  }

  private convertMessage(msg: Message): ChatCompletionMessageParam[] {
    if (msg.role === 'user') {
      return this.convertUserMessage(msg);
    }
    if (msg.role === 'assistant') {
      return this.convertAssistantMessage(msg);
    }
    return [];
  }

  private convertUserMessage(msg: Message): ChatCompletionMessageParam[] {
    if (typeof msg.content === 'string') {
      return [{ role: 'user', content: msg.content }];
    }

    const results: ChatCompletionMessageParam[] = [];
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultContent;
        results.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        } as ChatCompletionToolMessageParam);
      }
    }

    if (textParts.length > 0) {
      results.push({ role: 'user', content: textParts.join('\n') });
    }

    return results;
  }

  private convertAssistantMessage(msg: Message): ChatCompletionMessageParam[] {
    if (typeof msg.content === 'string') {
      return [{ role: 'assistant', content: msg.content }];
    }

    const textParts: string[] = [];
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_use') {
        const tu = block as ToolUseContent;
        toolCalls.push({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        });
      }
    }

    const assistantMsg: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: textParts.join('\n') || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return [assistantMsg];
  }

  // ===== Tool Building =====

  private buildTools(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  // ===== Response Parsing =====

  private parseResponse(response: OpenAI.ChatCompletion): ProviderResponse {
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
          input: this.parseToolArguments(tc.function.arguments),
        });
      }
    }

    return {
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: this.extractUsage(response.usage),
    };
  }

  private parseToolArguments(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }

  private mapStopReason(reason: string | null): ProviderResponse['stopReason'] {
    if (reason === 'tool_calls') return 'tool_use';
    if (reason === 'length') return 'max_tokens';
    return 'end_turn';
  }

  private extractUsage(usage?: OpenAI.CompletionUsage | null): TokenUsage {
    if (!usage) return { inputTokens: 0, outputTokens: 0 };

    const details = (usage as any).prompt_tokens_details;
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadTokens: details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    };
  }

  // ===== Retry Logic =====

  private async callWithRetry(
    params: OpenAI.ChatCompletionCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<OpenAI.ChatCompletion> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        return await this.client.chat.completions.create(params, { signal });
      } catch (error: any) {
        lastError = error;

        if (attempt > MAX_RETRIES || !this.shouldRetry(error)) {
          throw error;
        }

        const retryAfter = error.headers?.['retry-after'];
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32_000);

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private async callStreamWithRetry(
    params: OpenAI.ChatCompletionCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        return await this.client.chat.completions.create(params, { signal });
      } catch (error: any) {
        lastError = error;

        if (attempt > MAX_RETRIES || !this.shouldRetry(error)) {
          throw error;
        }

        const retryAfter = error.headers?.['retry-after'];
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32_000);

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private shouldRetry(error: any): boolean {
    if (error?.status === 429) return true;
    if (error?.status === 408) return true;
    if (error?.status >= 500) return true;
    if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') return true;
    return false;
  }
}
