// ============================================================
// Berry Agent SDK — Anthropic Provider
// ============================================================
// Full implementation wrapping @anthropic-ai/sdk.
// Key feature: intelligent cache_control breakpoint placement.

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlockParam,
  ContentBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
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
  ThinkingContent,
} from '../types.js';

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

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
      timeout: 120_000,
    });
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const system = this.buildSystemBlocks(request.systemPrompt);
    const messages = this.buildMessages(request.messages);
    const tools = request.tools ? this.buildTools(request.tools) : undefined;

    const params: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 16_384,
      system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    // Extended thinking
    if (this.config.thinkingBudget && this.config.thinkingBudget > 0) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: this.config.thinkingBudget,
      };
      // max_tokens must be > thinking budget
      params.max_tokens = Math.max(
        (this.config.maxTokens ?? 16_384),
        this.config.thinkingBudget + 1,
      );
    }

    const response = await this.callWithRetry(params, request.signal);

    return {
      content: this.parseResponseContent(response.content),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: this.extractUsage(response.usage),
    };
  }

  // ===== System Prompt =====
  // Split into blocks, each with cache_control: ephemeral.
  // This maximizes cache hits — stable prefix stays cached.

  private buildSystemBlocks(systemPrompt: string[]): TextBlockParam[] {
    return systemPrompt.filter(Boolean).map(text => ({
      type: 'text' as const,
      text,
      cache_control: { type: 'ephemeral' as const },
    }));
  }

  // ===== Messages =====
  // Convert Berry internal format → Anthropic MessageParam[].
  // Place cache_control on the last 2 user/assistant turn boundaries
  // (same strategy as CC source: `index > messages.length - 3`).

  private buildMessages(messages: Message[]): MessageParam[] {
    const result: MessageParam[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isRecentTurn = i > messages.length - 3;

      if (msg.role === 'user') {
        result.push(this.buildUserMessage(msg, isRecentTurn));
      } else if (msg.role === 'assistant') {
        result.push(this.buildAssistantMessage(msg, isRecentTurn));
      }
    }

    return result;
  }

  private buildUserMessage(msg: Message, addCache: boolean): MessageParam {
    if (typeof msg.content === 'string') {
      const block: TextBlockParam = {
        type: 'text',
        text: msg.content,
        ...(addCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      };
      return { role: 'user', content: [block] };
    }

    // Content blocks — may contain tool_result
    const content: ContentBlockParam[] = msg.content.map((block, idx) => {
      const isLast = idx === msg.content.length - 1;
      const cache = addCache && isLast
        ? { cache_control: { type: 'ephemeral' as const } }
        : {};

      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text, ...cache };
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result' as const,
          tool_use_id: (block as ToolResultContent).toolUseId,
          content: (block as ToolResultContent).content,
          is_error: (block as ToolResultContent).isError ?? false,
          ...cache,
        } as ToolResultBlockParam;
      }
      // Fallback: treat as text
      return { type: 'text' as const, text: JSON.stringify(block), ...cache };
    });

    return { role: 'user', content };
  }

  private buildAssistantMessage(msg: Message, addCache: boolean): MessageParam {
    if (typeof msg.content === 'string') {
      const block: TextBlockParam = {
        type: 'text',
        text: msg.content,
        ...(addCache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      };
      return { role: 'assistant', content: [block] };
    }

    const content: ContentBlockParam[] = msg.content
      .filter(block => block.type !== 'thinking') // Don't send thinking blocks back
      .map((block, idx, arr) => {
        const isLast = idx === arr.length - 1;
        const cache = addCache && isLast
          ? { cache_control: { type: 'ephemeral' as const } }
          : {};

        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text, ...cache };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: (block as ToolUseContent).id,
            name: (block as ToolUseContent).name,
            input: (block as ToolUseContent).input,
            ...cache,
          } as ToolUseBlockParam;
        }
        return { type: 'text' as const, text: JSON.stringify(block), ...cache };
      });

    return { role: 'assistant', content };
  }

  // ===== Tools =====

  private buildTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  // ===== Response Parsing =====

  private parseResponseContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
    return content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text } as TextContent;
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        } as ToolUseContent;
      }
      if (block.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: (block as any).thinking ?? '',
        } as ThinkingContent;
      }
      // Unknown block type
      return { type: 'text', text: JSON.stringify(block) } as TextContent;
    });
  }

  private mapStopReason(reason: string | null): ProviderResponse['stopReason'] {
    if (reason === 'tool_use') return 'tool_use';
    if (reason === 'max_tokens') return 'max_tokens';
    return 'end_turn';
  }

  private extractUsage(usage: any): TokenUsage {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    };
  }

  // ===== Retry Logic =====
  // Ported from CC source: exponential backoff with retry-after header support.

  private async callWithRetry(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      try {
        const response = await this.client.messages.create(
          params as unknown as MessageCreateParamsNonStreaming,
          { signal },
        );
        return response;
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
    if (error?.status === 429) return true; // rate limit
    if (error?.status === 408) return true; // timeout
    if (error?.status === 409) return true; // lock
    if (error?.status >= 500) return true;  // server error
    if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT') return true;
    return false;
  }
}
