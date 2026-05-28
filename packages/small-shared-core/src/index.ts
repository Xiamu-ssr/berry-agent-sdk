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

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Prefers `error.message` when the value carries one; otherwise falls back to
 * `String(error)`. Works for `Error` instances, plain objects with a `message`
 * field (provider SDK errors), and primitives.
 */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/**
 * Render a zod path as `root.foo[0].bar` style. Numeric segments use bracket
 * notation, string segments use dot notation. Callers handle the empty-path
 * case before calling this so they can supply their own root label.
 */
export function joinZodPath(root: string, path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((out, part) => (
    typeof part === 'number' ? `${out}[${part}]` : `${out}.${part}`
  ), root);
}

/**
 * Pull a message off a zod issue, falling back to a caller-supplied default
 * when the issue is missing or absent. Duck-typed so callers don't have to
 * import zod types here.
 */
export function zodIssueMessage(issue: { message?: string } | undefined, fallback = 'is invalid'): string {
  return issue?.message ?? fallback;
}

/**
 * Detect Node `ENOENT` errors thrown by fs operations and similar Node
 * built-ins. Duck-typed so callers don't have to depend on `NodeJS.ErrnoException`.
 */
export function isNoEntryError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
