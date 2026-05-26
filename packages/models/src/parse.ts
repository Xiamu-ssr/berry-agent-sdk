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
import { TIER_IDS } from './types.js';

export type ModelRef =
  | { kind: 'tier'; tier: TierId }
  | { kind: 'model'; modelId: string };

/** Parse a model reference string into a structured ModelRef. */
export function parseModelRef(spec: string): ModelRef {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Empty model reference');
  }

  if (trimmed.startsWith('tier:')) {
    const tier = trimmed.slice('tier:'.length).trim();
    if (!isTierId(tier)) {
      throw new Error(`Unknown tier "${tier}". Known tiers: ${TIER_IDS.join(', ')}`);
    }
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

function isTierId(value: string): value is TierId {
  return (TIER_IDS as readonly string[]).includes(value);
}
