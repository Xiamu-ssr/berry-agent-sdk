export enum SystemPromptCacheMode {
  Stable = 'stable',
  Dynamic = 'dynamic',
}

export interface SystemPromptBlock {
  text: string;
  cache: SystemPromptCacheMode;
}

export type SystemPromptInput = readonly SystemPromptBlock[];

export function normalizeSystemPrompt(
  prompt: SystemPromptInput | ReadonlyArray<SystemPromptBlock>,
): SystemPromptBlock[] {
  return [...prompt].map((block) => ({
    text: block.text,
    cache: block.cache,
  }));
}

export function flattenSystemPrompt(
  prompt: SystemPromptInput | ReadonlyArray<SystemPromptBlock>,
): string[] {
  return normalizeSystemPrompt(prompt).map((block) => block.text);
}
