import type OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions';
import type {
  Message,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  AnnotationContent,
} from '../../content-types.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { ProviderRequest } from '../../provider-types.js';
import { flattenSystemPrompt } from '@berry-agent/small-shared-core';

export function buildOpenAIMessages(
  systemPrompt: ProviderRequest['systemPrompt'],
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  const systemText = flattenSystemPrompt(systemPrompt).filter(Boolean).join('\n\n');
  if (systemText) {
    result.push({ role: 'system', content: systemText });
  }

  for (const msg of messages) {
    result.push(...convertOpenAIMessage(msg));
  }

  return result;
}

export function convertOpenAIMessage(msg: Message): ChatCompletionMessageParam[] {
  if (msg.role === 'user') {
    return convertOpenAIUserMessage(msg);
  }
  if (msg.role === 'assistant') {
    return convertOpenAIAssistantMessage(msg);
  }
  return [];
}

export function convertOpenAIUserMessage(msg: Message): ChatCompletionMessageParam[] {
  if (typeof msg.content === 'string') {
    return [{ role: 'user', content: msg.content }];
  }

  const results: ChatCompletionMessageParam[] = [];
  const textParts: string[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push((block as TextContent).text);
    } else if (block.type === 'image') {
      // Flush pending text before image so the OpenAI wire format stays valid
      // for gateways that do not accept mixed string/image content in one item.
      if (textParts.length > 0) {
        results.push({ role: 'user', content: textParts.join('\n') });
        textParts.length = 0;
      }
      results.push(openAIImageMessage(block as ImageContent));
    } else if (block.type === 'annotation') {
      const annotation = block as AnnotationContent;
      textParts.push(formatAnnotationForModel(annotation));
      results.push({ role: 'user', content: textParts.join('\n') });
      textParts.length = 0;
      results.push(openAIImageMessage({
        type: 'image',
        data: annotation.image.data,
        mediaType: annotation.image.mediaType,
      }));
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

function openAIImageMessage(img: ImageContent): ChatCompletionMessageParam {
  return {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.data}` },
      },
    ],
  } as OpenAI.ChatCompletionMessageParam;
}

function formatAnnotationForModel(block: AnnotationContent): string {
  const sourceTitle = block.source.title ? ` (${block.source.title})` : '';
  return [
    'Human browser annotation:',
    block.body,
    `Source: ${block.source.url}${sourceTitle}`,
    `Selected region: x=${Math.round(block.rect.x)}, y=${Math.round(block.rect.y)}, width=${Math.round(block.rect.width)}, height=${Math.round(block.rect.height)} of viewport ${Math.round(block.viewport.width)}x${Math.round(block.viewport.height)}.`,
    'The following image is the cropped highlighted region.',
  ].join('\n');
}

export function convertOpenAIAssistantMessage(msg: Message): ChatCompletionMessageParam[] {
  if (typeof msg.content === 'string') {
    return [{ role: 'assistant', content: msg.content }];
  }

  const textParts: string[] = [];
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
  const reasoningParts: string[] = [];

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
    } else if (block.type === 'thinking') {
      // Some OpenAI-compatible providers (e.g. Moonshot/Kimi) require
      // reasoning_content to be preserved for multi-turn thinking sessions.
      reasoningParts.push((block as { thinking: string }).thinking ?? '');
    }
  }

  const assistantMsg: ChatCompletionAssistantMessageParam & {
    reasoning_content?: string;
  } = {
    role: 'assistant',
    content: textParts.join('\n') || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  // Moonshot/Kimi requires reasoning_content on EVERY assistant message when
  // thinking is enabled, even if empty.
  assistantMsg.reasoning_content = reasoningParts.join('\n');

  return [assistantMsg];
}

export function buildOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
