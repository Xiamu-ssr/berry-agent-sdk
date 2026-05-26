// Browser-safe safety level primitives.

/** Three safety presets, ordered from most permissive to most cautious. */
export const SAFETY_LEVELS = ['trust', 'default', 'auto'] as const;
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

/** Narrow a possibly-arbitrary string into a SafetyLevel, or null. */
export function asSafetyLevel(value: unknown): SafetyLevel | null {
  if (typeof value !== 'string') return null;
  return (SAFETY_LEVELS as readonly string[]).includes(value)
    ? (value as SafetyLevel)
    : null;
}
