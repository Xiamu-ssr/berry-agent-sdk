// ============================================================
// @berry-agent/models — Agent model reference parser
// ============================================================
// Agents store their model choice as a single string so config stays flat.
// Three syntactic forms, each maps to a different resolve path:
//
//   tier:strong            → Layer 3  (shortcut into a tier)
//   model:claude-opus-4.7  → Layer 2  (named model binding with failover)
//   raw:base64(json)       → Escape hatch: raw ProviderConfig, bypasses models
//
// Plain bare strings without a prefix are treated as Layer 2 model ids (the
// most common case) so existing configs keep working.

import type { ProviderConfig } from '@berry-agent/core';
import type { TierId } from './types.js';
import { TIER_IDS } from './types.js';

export type ModelRef =
  | { kind: 'tier'; tier: TierId }
  | { kind: 'model'; modelId: string }
  | { kind: 'raw'; config: ProviderConfig };

/** Parse a raw model reference string into a structured ModelRef. */
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
    const payload = trimmed.slice('raw:'.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBase64Maybe(payload));
    } catch (err) {
      throw new Error(`raw:... payload is not valid JSON: ${(err as Error).message}`);
    }
    const cfg = normalizeRawConfig(parsed);
    return { kind: 'raw', config: cfg };
  }

  // Bare string → treat as model id (Layer 2).
  return { kind: 'model', modelId: trimmed };
}

/** Build a raw: spec string from a ProviderConfig. */
export function formatRawRef(cfg: ProviderConfig): string {
  return `raw:${JSON.stringify(cfg)}`;
}

function isTierId(value: string): value is TierId {
  return (TIER_IDS as readonly string[]).includes(value);
}

function decodeBase64Maybe(payload: string): string {
  // If the payload already starts with '{', assume it's inline JSON.
  if (payload.trimStart().startsWith('{')) return payload;
  // Otherwise try to decode base64 for users who prefer opaque tokens.
  try {
    return Buffer.from(payload, 'base64').toString('utf-8');
  } catch {
    return payload;
  }
}

function normalizeRawConfig(value: unknown): ProviderConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('raw: payload must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.type !== 'anthropic' && obj.type !== 'openai') {
    throw new Error(`raw: payload has invalid type "${obj.type}"`);
  }
  if (typeof obj.apiKey !== 'string' || !obj.apiKey) {
    throw new Error('raw: payload missing apiKey');
  }
  if (typeof obj.model !== 'string' || !obj.model) {
    throw new Error('raw: payload missing model');
  }
  return {
    type: obj.type,
    apiKey: obj.apiKey,
    model: obj.model,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
    maxTokens: typeof obj.maxTokens === 'number' ? obj.maxTokens : undefined,
    thinkingBudget: typeof obj.thinkingBudget === 'number' ? obj.thinkingBudget : undefined,
  };
}
