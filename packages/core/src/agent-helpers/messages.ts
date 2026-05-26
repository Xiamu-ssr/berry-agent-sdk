// ============================================================
// Agent helpers — message / tool list manipulation
// ============================================================
// Pure transforms over Message / ToolRegistration arrays. No
// side effects except repairOrphanToolUses which mutates the
// array in-place by design (documented below).

import type {
  Message,
  AnnotationContent,
  TextContent,
} from '../content-types.js';
import type { TokenUsage } from '../provider-types.js';
import type { ToolRegistration } from '../tool-types.js';
export { repairOrphanToolUses } from '../message-repair.js';

export function extractText(message: Message): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .flatMap((b): string[] => {
      if (b.type === 'text') return [(b as TextContent).text];
      if (b.type === 'annotation') return [formatAnnotationText(b as AnnotationContent)];
      return [];
    })
    .join('\n');
}

function formatAnnotationText(block: AnnotationContent): string {
  const title = block.source.title ? ` (${block.source.title})` : '';
  return [
    `[annotation] ${block.body}`,
    `source: ${block.source.url}${title}`,
    `rect: x=${block.rect.x}, y=${block.rect.y}, width=${block.rect.width}, height=${block.rect.height}`,
  ].join('\n');
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
