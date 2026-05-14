// ============================================================
// ModelResolverSnapshot — frozen view of a resolver's state
// ============================================================
// Returned by `ModelResolverWithSnapshot.getSnapshot()`. Intentionally a
// typed class (not plain JSON) so that host products can
// pass resolver state around with the same guarantees the Agent side has
// via AgentSnapshot.
//
// Mirrors only observable runtime state (pointer, exhaustion, lastError
// summary) — NOT credentials. The `providers` array carries provider ids
// only; callers that need apiKey/baseUrl look them up in the ModelsRegistry.

import type { ModelProviderRef } from './types.js';

/**
 * Compact snapshot of the last error seen by the resolver. We intentionally
 * avoid carrying the raw error object — it may have framework-specific
 * metadata that shouldn't leak across module boundaries, and serializing
 * it naively risks circular references.
 */
export interface ResolverErrorSummary {
  /** Error name / class (e.g. `'ModelResolveError'`, `'TypeError'`). */
  readonly name: string;
  /** Human-readable message. */
  readonly message: string;
  /** Error code when the error was a ModelResolveError, else undefined. */
  readonly code?: string;
}

export interface ModelResolverSnapshotData {
  /** Resolver id (`model:X` or `tier:Y:X`). */
  readonly id: string;
  /** Model binding id this resolver resolves. */
  readonly modelId: string;
  /** Ordered list of providers this resolver will walk, in rotation order. */
  readonly providers: readonly ModelProviderRef[];
  /** Index into `providers` for the currently-selected provider. */
  readonly pointer: number;
  /**
   * True when every provider has been exhausted. Further `resolve()` calls
   * will throw until `resetForSession()` is invoked.
   */
  readonly exhausted: boolean;
  /** Compact summary of the last error, or undefined if none has occurred. */
  readonly lastError?: ResolverErrorSummary;
  /** When this snapshot was taken (ms since epoch). */
  readonly capturedAt: number;
}

export class ModelResolverSnapshot implements ModelResolverSnapshotData {
  readonly id: string;
  readonly modelId: string;
  readonly providers: readonly ModelProviderRef[];
  readonly pointer: number;
  readonly exhausted: boolean;
  readonly lastError?: ResolverErrorSummary;
  readonly capturedAt: number;

  constructor(data: ModelResolverSnapshotData) {
    this.id = data.id;
    this.modelId = data.modelId;
    this.providers = data.providers;
    this.pointer = data.pointer;
    this.exhausted = data.exhausted;
    this.lastError = data.lastError;
    this.capturedAt = data.capturedAt;
  }

  /** Plain-data projection for logging / serialization. */
  toJSON(): ModelResolverSnapshotData {
    return {
      id: this.id,
      modelId: this.modelId,
      providers: this.providers,
      pointer: this.pointer,
      exhausted: this.exhausted,
      lastError: this.lastError,
      capturedAt: this.capturedAt,
    };
  }
}

/** Extract an error summary without carrying the raw Error object. */
export function summarizeError(err: unknown): ResolverErrorSummary | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    const withCode = err as Error & { code?: unknown };
    return {
      name: err.name,
      message: err.message,
      code: typeof withCode.code === 'string' ? withCode.code : undefined,
    };
  }
  return { name: 'UnknownError', message: String(err) };
}
