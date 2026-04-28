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
import { normalizeSystemPrompt } from '../types.js';
import { DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } from '../constants.js';
import { withRetry } from '../utils/retry.js';

// Extended Anthropic SDK types for beta features (thinking, etc.)
interface ThinkingDelta { type: 'thinking_delta'; thinking: string }
interface ThinkingBlock { type: 'thinking'; thinking: string }
// Image block must satisfy ContentBlockParam union (ImageBlockParam)
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; [k: string]: unknown }

const ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4;
const ANTHROPIC_MAX_MESSAGE_CACHE_BREAKPOINTS = 2;

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

    const content = this.parseResponseContent(response.content);
    const rawStopReason = this.mapStopReason(response.stop_reason);
    return {
      content,
      stopReason: this.reconcileStopReason(rawStopReason, content),
      usage: this.extractUsage(response.usage),
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
    // Accumulate raw message for rawResponse
    let rawMessageId: string | undefined;
    let rawMessageModel: string | undefined;
    let rawMessageType: string | undefined;
    let rawUsageRaw: Record<string, unknown> = {};

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          usage = this.extractUsage(event.message.usage);
          rawUsageRaw = event.message.usage as unknown as Record<string, unknown>;
          rawMessageId = event.message.id;
          rawMessageModel = event.message.model;
          rawMessageType = event.message.type;
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
            const thinking = (delta as unknown as ThinkingDelta).thinking ?? '';
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
          rawUsageRaw = event.usage as unknown as Record<string, unknown>;
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
    // Reconcile: proxy layers may report wrong stop_reason
    const reconciledStopReason = this.reconcileStopReason(stopReason, finalContent);

    const rawResponse: Record<string, unknown> = {
      id: rawMessageId,
      type: rawMessageType,
      model: rawMessageModel,
      stop_reason: reconciledStopReason === 'tool_use' ? 'tool_use' : reconciledStopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      usage: rawUsageRaw,
      content: finalContent,
    };

    yield {
      type: 'response',
      response: {
        content: finalContent.length > 0 ? finalContent : [{ type: 'text', text: '' }],
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
    const system = this.buildSystemBlocks(request.systemPrompt);
    const remainingCacheBreakpoints = Math.max(
      0,
      ANTHROPIC_CACHE_BREAKPOINT_BUDGET - countCacheBreakpoints(system),
    );
    const messages = this.buildMessages(
      request.messages,
      Math.min(ANTHROPIC_MAX_MESSAGE_CACHE_BREAKPOINTS, remainingCacheBreakpoints),
    );
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
    };
    const budget = map[effort] ?? 16000;
    // Cap at maxTokens - 1 so there's room for output
    return Math.min(budget, maxTokens - 1);
  }

  private buildStreamParams(request: ProviderRequest): Record<string, unknown> {
    return {
      ...this.buildParams(request),
      stream: true,
    };
  }

  // ===== System Prompt =====
  // Cache the last stable system block plus the final system block boundary.
  // This lets Anthropic reuse the stable prefix while still separating any
  // dynamic tail content from the full prompt boundary.

  buildSystemBlocks(systemPrompt: ProviderRequest['systemPrompt']): TextBlockParam[] {
    const blocks = normalizeSystemPrompt(systemPrompt).filter(block => block.text);
    let lastStableIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.cache !== 'dynamic') {
        lastStableIndex = i;
        break;
      }
    }

    const cacheBreakpointIndexes = new Set<number>();
    if (lastStableIndex >= 0) cacheBreakpointIndexes.add(lastStableIndex);
    if (blocks.length > 0) cacheBreakpointIndexes.add(blocks.length - 1);

    return blocks.map((block, idx) => ({
      type: 'text' as const,
      text: block.text,
      ...(cacheBreakpointIndexes.has(idx)
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));
  }

  // ===== Messages =====
  // Convert Berry internal format → Anthropic MessageParam[].
  // Place cache_control on the most recent user/assistant message boundaries
  // without exceeding Anthropic's total breakpoint budget.

  buildMessages(
    messages: Message[],
    cacheBudget: number = ANTHROPIC_MAX_MESSAGE_CACHE_BREAKPOINTS,
  ): MessageParam[] {
    const result: MessageParam[] = [];
    const cacheStartIndex = Math.max(messages.length - cacheBudget, 0);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isRecentTurn = cacheBudget > 0 && i >= cacheStartIndex;

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

    // Anthropic requires tool_result blocks to come FIRST in the user message,
    // with any text / image blocks AFTER all tool_results.
    const toolResults: ContentBlockParam[] = [];
    const otherBlocks: ContentBlockParam[] = [];

    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: (block as ToolResultContent).toolUseId,
          content: (block as ToolResultContent).content,
          is_error: (block as ToolResultContent).isError ?? false,
        } as ToolResultBlockParam);
      } else if (block.type === 'text') {
        otherBlocks.push({ type: 'text' as const, text: block.text });
      } else if (block.type === 'image') {
        otherBlocks.push({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: (block as ImageContent).mediaType,
            data: (block as ImageContent).data,
          },
        } as unknown as ContentBlockParam);
      } else {
        otherBlocks.push({ type: 'text' as const, text: JSON.stringify(block) });
      }
    }

    const content: ContentBlockParam[] = [...toolResults, ...otherBlocks];

    if (addCache && content.length > 0) {
      const last = content[content.length - 1]!;
      (last as TextBlockParam & { cache_control?: unknown }).cache_control = { type: 'ephemeral' as const };
    }

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

    const content: ContentBlockParam[] = msg.content.map((block, idx, arr) => {
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
      if (block.type === 'thinking') {
        const t = block as ThinkingContent;
        return {
          type: 'thinking' as const,
          thinking: t.thinking,
          signature: t.signature ?? '',
          ...cache,
        } as unknown as ContentBlockParam;
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
        const b = block as unknown as { thinking?: string; signature?: string };
        return {
          type: 'thinking',
          thinking: b.thinking ?? '',
          signature: b.signature,
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
      const b = block as unknown as { thinking?: string; signature?: string };
      return {
        type: 'thinking',
        thinking: b.thinking ?? '',
        signature: b.signature,
      };
    }
    return undefined;
  }

  private mapStopReason(reason: string | null): ProviderResponse['stopReason'] {
    if (reason === 'tool_use') return 'tool_use';
    if (reason === 'max_tokens') return 'max_tokens';
    return 'end_turn';
  }

  /**
   * Reconcile stop_reason with actual response content. Some proxy layers
   * (zenmux, OpenRouter) can return stop_reason='end_turn' while the content
   * actually contains tool_use blocks (e.g. when streaming is interrupted or
   * the proxy reassembles chunks incorrectly). The Anthropic API itself is
   * authoritative: if content has tool_use blocks, the semantic stop reason
   * is 'tool_use' regardless of what the wire says.
   */
  private reconcileStopReason(
    stopReason: ProviderResponse['stopReason'],
    content: ContentBlock[],
  ): ProviderResponse['stopReason'] {
    const hasToolUse = content.some(b => b.type === 'tool_use');
    if (hasToolUse && stopReason !== 'tool_use') {
      return 'tool_use';
    }
    return stopReason;
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

function countCacheBreakpoints(blocks: Array<{ cache_control?: unknown }>): number {
  return blocks.reduce((count, block) => count + (block.cache_control ? 1 : 0), 0);
}
