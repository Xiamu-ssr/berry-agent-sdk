// ============================================================
// Agent helpers — message / tool list manipulation
// ============================================================
// Pure transforms over Message / ToolRegistration arrays. No
// side effects except repairOrphanToolUses which mutates the
// array in-place by design (documented below).

import type {
  Message,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  TokenUsage,
  ToolRegistration,
} from '../types.js';

export function extractText(message: Message): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

export function accumulateUsage(total: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
  };
}

/**
 * Merge two tool lists by name, with `primary` winning on conflict.
 * Preserves primary's order where possible; secondary-only tools append.
 */
export function mergeToolsByName(primary: ToolRegistration[], secondary: ToolRegistration[]): ToolRegistration[] {
  const merged = new Map<string, ToolRegistration>();

  for (const tool of secondary) {
    merged.set(tool.definition.name, tool);
  }

  for (const tool of primary) {
    merged.set(tool.definition.name, tool);
  }

  return [...merged.values()];
}

/**
 * Repair orphan tool_use blocks: if an assistant message contains tool_use
 * blocks but the immediately following message is NOT a user message with
 * matching tool_result blocks, inject synthetic tool_result(s) so the
 * Anthropic API doesn't reject the entire conversation.
 *
 * This is a defensive measure against the stop_reason desync bug where
 * streaming returns stop_reason='end_turn' despite tool_use content.
 *
 * Modifies `messages` in place. Safe to call multiple times (idempotent).
 */
export function repairOrphanToolUses(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const toolUseIds = blocks
      .filter((b): b is ToolUseContent => (b as ContentBlock).type === 'tool_use')
      .map(b => b.id);
    if (toolUseIds.length === 0) continue;

    // Check if the next message is a user message containing tool_result
    // blocks for every tool_use id.
    const next = messages[i + 1];
    if (next && next.role === 'user') {
      const nextBlocks = Array.isArray(next.content) ? next.content : [];
      const resultIds = new Set(
        nextBlocks
          .filter((b): b is ToolResultContent => (b as ContentBlock).type === 'tool_result')
          .map(b => b.toolUseId),
      );
      if (toolUseIds.every(id => resultIds.has(id))) continue; // all matched
    }

    // Orphan detected — inject synthetic tool_result blocks
    const syntheticBlocks: ContentBlock[] = toolUseIds.map(id => ({
      type: 'tool_result' as const,
      toolUseId: id,
      content: '[Berry SDK] Session repair: tool execution was interrupted. This tool_result was synthesized to maintain conversation integrity.',
      isError: true,
    }));
    messages.splice(i + 1, 0, {
      role: 'user',
      content: syntheticBlocks,
      createdAt: Date.now(),
    });
  }
}
