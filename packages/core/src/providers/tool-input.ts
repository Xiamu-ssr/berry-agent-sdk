// ============================================================
// Provider Tool Input Boundary
// ============================================================

export function normalizeProviderToolInput(value: unknown, rawFallback?: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (rawFallback !== undefined) {
    return { _raw: rawFallback };
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { _raw: value };
}

export function parseProviderToolInputJSON(raw: string): Record<string, unknown> {
  try {
    return normalizeProviderToolInput(JSON.parse(raw), raw);
  } catch {
    return { _raw: raw };
  }
}
