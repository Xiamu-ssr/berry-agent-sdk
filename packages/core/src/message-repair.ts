import type {
  ContentBlock,
  Message,
  ToolResultContent,
  ToolUseContent,
} from './content-types.js';

const SYNTHETIC_REPAIR_TEXT =
  '[Berry SDK] Session repair: tool execution was interrupted. This tool_result was synthesized to maintain conversation integrity.';

/**
 * Repair assistant tool_use blocks that are not immediately followed by
 * matching user tool_result blocks.
 *
 * Provider APIs treat this adjacency as part of the conversation protocol.
 * We keep the repair in one shared helper so session resume and event-log
 * recovery cannot drift.
 */
export function repairOrphanToolUses(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((block): block is ToolUseContent => block.type === 'tool_use')
      .map((block) => block.id);
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const nextBlocks = next?.role === 'user'
      ? contentAsBlocks(next.content)
      : undefined;
    const immediateResultIds = new Set(
      (nextBlocks ?? [])
        .filter((block): block is ToolResultContent => block.type === 'tool_result')
        .map((block) => block.toolUseId),
    );
    const missing = toolUseIds.filter((id) => !immediateResultIds.has(id));
    if (missing.length === 0) continue;

    const repairBlocks: ContentBlock[] = [];
    for (const id of missing) {
      const displaced = takeLaterToolResult(messages, i + 2, id);
      repairBlocks.push(displaced ?? syntheticToolResult(id));
    }

    if (next && nextBlocks) {
      next.content = [...repairBlocks, ...nextBlocks];
      continue;
    }

    messages.splice(i + 1, 0, {
      role: 'user',
      content: repairBlocks,
      createdAt: Date.now(),
    });
    i++;
  }
}

function contentAsBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
}

function takeLaterToolResult(
  messages: Message[],
  startIndex: number,
  toolUseId: string,
): ToolResultContent | null {
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const index = msg.content.findIndex(
      (block) => block.type === 'tool_result' && block.toolUseId === toolUseId,
    );
    if (index < 0) continue;

    const [block] = msg.content.splice(index, 1);
    if (msg.content.length === 0) messages.splice(i, 1);
    return block as ToolResultContent;
  }
  return null;
}

function syntheticToolResult(toolUseId: string): ToolResultContent {
  return {
    type: 'tool_result',
    toolUseId,
    content: SYNTHETIC_REPAIR_TEXT,
    isError: true,
  };
}
