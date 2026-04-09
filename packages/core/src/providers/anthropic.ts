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
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
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
  ThinkingContent,
  ImageContent,
} from '../types.js';
import { DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } from '../constants.js';
import { withRetry } from '../utils/retry.js';

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

    return {
      content: this.parseResponseContent(response.content),
      stopReason: this.mapStopReason(response.stop_reason),
      usage: this.extractUsage(response.usage),
    };
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const params = this.buildStreamParams(request);
    const stream = await withRetry(
      () => this.client.messages.create(params as unknown as MessageCreateParamsStreaming, { signal: request.signal }),
      request.signal,
    ) as AsyncIterable<RawMessageStreamEvent>;

    const content: Array<ContentBlock | undefined> = [];
    const toolInputJson = new Map<number, string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: ProviderResponse['stopReason'] = 'end_turn';

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          usage = this.extractUsage(event.message.usage);
          break;
        }
        case 'content_block_start': {
          const block = this.parseStreamStartBlock(event.content_block);
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
            const thinking = (delta as any).thinking ?? '';
            const target = block && block.type === 'thinking'
              ? block
              : ({ type: 'thinking', thinking: '' } satisfies ThinkingContent);
            target.thinking += thinking;
            content[event.index] = target;
            if (thinking) {
              yield { type: 'thinking_delta', thinking };
            }
          } else if (delta.type === 'input_json_delta') {
            toolInputJson.set(event.index, (toolInputJson.get(event.index) ?? '') + delta.partial_json);
          }
          break;
        }
        case 'content_block_stop': {
          const block = content[event.index];
          const partialJson = toolInputJson.get(event.index);
          if (block?.type === 'tool_use' && partialJson) {
            try {
              block.input = JSON.parse(partialJson) as Record<string, unknown>;
            } catch {
              block.input = { _raw: partialJson };
            }
          }
          break;
        }
        case 'message_delta': {
          usage = this.extractUsage(event.usage);
          stopReason = this.mapStopReason(event.delta.stop_reason);
          break;
        }
        case 'message_stop':
          break;
        default:
          break;
      }
    }

    const finalContent = content.filter((block): block is ContentBlock => block !== undefined);

    yield {
      type: 'response',
      response: {
        content: finalContent.length > 0 ? finalContent : [{ type: 'text', text: '' }],
        stopReason,
        usage,
      },
    };
  }

  // ===== Params =====

  private buildParams(request: ProviderRequest): Record<string, unknown> {
    const system = this.buildSystemBlocks(request.systemPrompt);
    const messages = this.buildMessages(request.messages);
    const tools = (request.tools || request.responseFormat)
      ? this.buildTools(request.tools ?? [], request.responseFormat)
      : undefined;

    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const params: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    if (this.config.thinkingBudget && this.config.thinkingBudget > 0) {
      params.thinking = {
        type: 'enabled',
        budget_tokens: this.config.thinkingBudget,
      };
      params.max_tokens = Math.max(maxTokens, this.config.thinkingBudget + 1);
    }

    return params;
  }

  private buildStreamParams(request: ProviderRequest): Record<string, unknown> {
    return {
      ...this.buildParams(request),
      stream: true,
    };
  }

  // ===== System Prompt =====
  // Split into blocks, each with cache_control: ephemeral.
  // This maximizes cache hits — stable prefix stays cached.

  buildSystemBlocks(systemPrompt: string[]): TextBlockParam[] {
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

  buildMessages(messages: Message[]): MessageParam[] {
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
      if (block.type === 'image') {
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: (block as ImageContent).mediaType,
            data: (block as ImageContent).data,
          },
          ...cache,
        } as any;
      }
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
      .filter(block => block.type !== 'thinking')
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

  private buildTools(tools: ToolDefinition[], responseFormat?: ProviderRequest['responseFormat']): Anthropic.Tool[] {
    const mapped = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    // Structured output: add a virtual tool for JSON extraction
    if (responseFormat) {
      mapped.push({
        name: responseFormat.name,
        description: responseFormat.description ?? `Return structured JSON output matching the ${responseFormat.name} schema.`,
        input_schema: responseFormat.schema as Anthropic.Tool.InputSchema,
      });
    }

    return mapped;
  }

  // ===== Response Parsing =====

  parseResponseContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
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
      return { type: 'text', text: JSON.stringify(block) } as TextContent;
    });
  }

  private parseStreamStartBlock(block: Anthropic.ContentBlock): ContentBlock | undefined {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
      };
    }
    if (block.type === 'thinking') {
      return {
        type: 'thinking',
        thinking: (block as any).thinking ?? '',
      };
    }
    return undefined;
  }

  private mapStopReason(reason: string | null): ProviderResponse['stopReason'] {
    if (reason === 'tool_use') return 'tool_use';
    if (reason === 'max_tokens') return 'max_tokens';
    return 'end_turn';
  }

  private extractUsage(usage: any): TokenUsage {
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    };
  }
}
