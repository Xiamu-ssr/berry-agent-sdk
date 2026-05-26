import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ContentBlock, TextContent, ThinkingContent, ToolUseContent } from '../../content-types.js';
import type { ProviderResponse, TokenUsage } from '../../provider-types.js';
import { normalizeProviderToolInput } from '../tool-input.js';

const anthropicThinkingBlockSchema = z.object({
  thinking: z.string().optional(),
  signature: z.string().optional(),
});

function parseAnthropicThinkingBlock(block: Anthropic.ContentBlock): ThinkingContent {
  const parsed = anthropicThinkingBlockSchema.safeParse(block);
  const data = parsed.success ? parsed.data : {};
  return {
    type: 'thinking',
    thinking: data.thinking ?? '',
    signature: data.signature,
  };
}

export function parseAnthropicResponseContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text } as TextContent;
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: normalizeProviderToolInput(block.input),
      } as ToolUseContent;
    }
    if (block.type === 'thinking') {
      return parseAnthropicThinkingBlock(block);
    }
    return { type: 'text', text: JSON.stringify(block) } as TextContent;
  });
}

export function parseAnthropicStreamStartBlock(block: Anthropic.ContentBlock): ContentBlock | undefined {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: normalizeProviderToolInput(block.input),
    };
  }
  if (block.type === 'thinking') {
    return parseAnthropicThinkingBlock(block);
  }
  return undefined;
}

export function mapAnthropicStopReason(reason: string | null): ProviderResponse['stopReason'] {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

/**
 * Reconcile stop_reason with actual response content. Some proxy layers
 * (zenmux, OpenRouter) can return stop_reason='end_turn' while the content
 * actually contains tool_use blocks. The semantic stop reason must follow
 * the content so the agent executes tools and does not persist orphan tool_use.
 */
export function reconcileAnthropicStopReason(
  stopReason: ProviderResponse['stopReason'],
  content: ContentBlock[],
): ProviderResponse['stopReason'] {
  const hasToolUse = content.some(b => b.type === 'tool_use');
  if (hasToolUse && stopReason !== 'tool_use') {
    return 'tool_use';
  }
  return stopReason;
}

export function extractAnthropicUsage(usage: unknown): TokenUsage {
  // SDK contract: TokenUsage.inputTokens is the *total* input tokens this
  // call billed against the context window. Anthropic's wire format reports
  // input_tokens excluding cached portions, so we synthesize the total here.
  // cacheRead/cacheWrite are subsets of inputTokens for disclosure only.
  const record = asRecord(usage);
  const cacheRead = numberField(record, 'cache_read_input_tokens');
  const cacheWrite = numberField(record, 'cache_creation_input_tokens');
  const rawInput = numberField(record, 'input_tokens');
  return {
    inputTokens: rawInput + cacheRead + cacheWrite,
    outputTokens: numberField(record, 'output_tokens'),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
