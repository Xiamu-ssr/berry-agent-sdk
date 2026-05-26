import type {
  AnnotationContent,
  ContentBlock,
  TextContent,
} from './content-types.js';

export function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block): string[] => {
      if (block.type === 'text') return [(block as TextContent).text];
      if (block.type === 'annotation') return [formatAnnotationSummary(block as AnnotationContent)];
      return [];
    })
    .join('\n');
}

export function thinkingFromBlocks(blocks: ContentBlock[]): string | undefined {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n') || undefined;
}

export function previewTextForBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'annotation') return formatAnnotationSummary(block as AnnotationContent);
  return `[${block.type}]`;
}

export function stablePromptSuffix(prompt: string | ContentBlock[]): string {
  const text = typeof prompt === 'string'
    ? prompt
    : prompt.map(previewTextForBlock).join('|');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function formatAnnotationSummary(block: AnnotationContent): string {
  const sourceTitle = block.source.title ? ` (${block.source.title})` : '';
  return [
    `Annotation: ${block.body}`,
    `Source: ${block.source.url}${sourceTitle}`,
  ].join('\n');
}
