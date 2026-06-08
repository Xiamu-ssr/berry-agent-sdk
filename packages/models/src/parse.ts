// ============================================================
// @berry-agent/models — Agent model reference parser
// ============================================================
// Agents store their model choice as a single string so config stays flat.
// Three syntactic forms, each maps to a different resolve path:
//
//   tier:strong            → Layer 3  (shortcut into a tier)
//   model:claude-opus-4.7  → Layer 2  (named model binding with failover)
// Plain bare strings without a prefix are treated as Layer 2 model ids (the
// most common case) so existing configs keep working.

import type { TierId } from './types.js';

export type ModelRef =
  | { kind: 'tier'; tier: TierId }
  | { kind: 'model'; modelId: string };

/**
 * Parse a model reference string into a structured ModelRef.
 *
 * `tier:X` is parsed *syntactically* — any non-empty tier name is accepted.
 * The tier vocabulary is operator data (the models template defines which
 * tiers exist), NOT a hardcoded enum: validation belongs to the resolver,
 * which checks `tier:X` against the live registry and throws
 * `tier_unconfigured` with a precise message. Gating here against a fixed
 * list would reject operator-defined tiers (e.g. `cheap`) that the template
 * and UI legitimately offer.
 */
export function parseModelRef(spec: string): ModelRef {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Empty model reference');
  }

  if (trimmed.startsWith('tier:')) {
    const tier = trimmed.slice('tier:'.length).trim();
    if (!tier) throw new Error('Empty tier name after "tier:"');
    return { kind: 'tier', tier };
  }

  if (trimmed.startsWith('model:')) {
    const modelId = trimmed.slice('model:'.length).trim();
    if (!modelId) throw new Error('Empty model id after "model:"');
    return { kind: 'model', modelId };
  }

  if (trimmed.startsWith('raw:')) {
    throw new Error('raw: model references are not supported. Configure custom providers in provider instances.');
  }

  // Bare string → treat as model id (Layer 2).
  return { kind: 'model', modelId: trimmed };
}
