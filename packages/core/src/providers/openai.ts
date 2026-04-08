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
} from 'openai/resources/chat/completions';
import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
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
      maxRetries: 0, // We handle retries
      timeout: 120_000,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const messages = this.buildMessages(request.systemPrompt, request.messages);
    const tools = request.tools ? this.buildTools(request.tools) : undefined;

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens ?? 16_384,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const response = await this.callWithRetry(params, request.signal);

    return this.parseResponse(response);
  }

  // ===== Message Building =====
  // Berry internal format → OpenAI ChatCompletionMessageParam[]

  private buildMessages(
    systemPrompt: string[],
    messages: Message[],
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    // System prompt: join all blocks into one system message
    // (OpenAI only supports one system message, no block-level cache control)
    const systemText = systemPrompt.filter(Boolean).join('\n\n');
    if (systemText) {
      result.push({ role: 'system', content: systemText });
    }

    // Convert each Berry message
    for (const msg of messages) {
      const converted = this.convertMessage(msg);
      result.push(...converted);
    }

    return result;
  }

  /**
   * Convert one Berry Message → one or more OpenAI messages.
   * 
   * Why multiple? A Berry user message with tool_result blocks
   * becomes separate role:"tool" messages in OpenAI format.
   */
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
    // Simple text message
    if (typeof msg.content === 'string') {
      return [{ role: 'user', content: msg.content }];
    }

    // Content blocks — may contain tool_result and/or text
    const results: ChatCompletionMessageParam[] = [];
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_result') {
        const tr = block as ToolResultContent;
        // OpenAI: tool results are separate role:"tool" messages
        results.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        } as ChatCompletionToolMessageParam);
      }
    }

    // If there's text alongside tool results, add as user message AFTER
    if (textParts.length > 0) {
      results.push({ role: 'user', content: textParts.join('\n') });
    }

    return results;
  }

  private convertAssistantMessage(msg: Message): ChatCompletionMessageParam[] {
    if (typeof msg.content === 'string') {
      return [{ role: 'assistant', content: msg.content }];
    }

    // Build assistant message with possible tool_calls
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
            arguments: JSON.stringify(tu.input), // OpenAI: JSON string!
          },
        });
      }
      // thinking blocks: skip (OpenAI doesn't have them)
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
  // OpenAI response → Berry internal format

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

    // Text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    // Tool calls → Berry ToolUseContent
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        // OpenAI SDK v5: ToolCall = FunctionToolCall | CustomToolCall
        // We only handle function tool calls
        if (!('function' in tc) || !tc.function) continue;
        const fn = tc.function as { name: string; arguments: string };
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = { _raw: fn.arguments };
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: fn.name,
          input,
        });
      }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: this.extractUsage(response.usage),
    };
  }

  private mapStopReason(reason: string | null): ProviderResponse['stopReason'] {
    if (reason === 'tool_calls') return 'tool_use';
    if (reason === 'length') return 'max_tokens';
    return 'end_turn';
  }

  private extractUsage(usage?: OpenAI.CompletionUsage): TokenUsage {
    if (!usage) return { inputTokens: 0, outputTokens: 0 };

    // OpenAI provides cache info in prompt_tokens_details (when available)
    const details = (usage as any).prompt_tokens_details;
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadTokens: details?.cached_tokens ?? 0,
      cacheWriteTokens: 0, // OpenAI doesn't charge for cache writes
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
        return await this.client.chat.completions.create(
          params,
          { signal },
        );
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
