// ============================================================
// @berry-agent/models — Protocol family routing
// ============================================================
// A model's wire protocol is NOT configured by the operator — it is inferred
// from the model family. This is the single source of truth for "which
// protocol does this model speak", consumed by the resolver (to pick the
// provider endpoint + ProviderConfig.type) and surfaced to the UI (so the
// model picker can lock an agent/session to one protocol family).
//
// Why family-driven and not per-provider: the SAME vendor channel (e.g.
// zenmux) serves Claude over the anthropic protocol and GPT/Kimi over the
// openai protocol, at different URLs. Coupling protocol to the provider preset
// (the old design) forced Claude through the openai path, silently bypassing
// anthropic prompt caching. Routing by family fixes that at the root.

import type { WireProtocol } from './types.js';

// Anchored on word boundaries / common id delimiters ( / - _ : . ) so a
// substring like "gpt-claude-clone" doesn't false-positive, while the real
// shapes all match: claude-opus-4.7, anthropic/claude-opus-4.7,
// claude-haiku-4.5, opus-4.8, sonnet-4.6.
const ANTHROPIC_FAMILY = /(?:^|[/\-_:])(?:claude|opus|sonnet|haiku)(?:$|[/\-_:.\d])/i;

/**
 * Infer a model's wire protocol from its family.
 *
 * Claude family (claude / opus / sonnet / haiku) → 'anthropic'.
 * Everything else → 'openai'.
 *
 * Checks the user-facing `modelId` first, then the provider-specific
 * `remoteModelId` (e.g. the bare id is `claude-opus-4.8` but a gateway routes
 * it as `anthropic/claude-opus-4.8`, or vice-versa) — either matching the
 * Claude family is enough.
 */
export function modelProtocolFamily(modelId: string, remoteModelId?: string): WireProtocol {
  if (ANTHROPIC_FAMILY.test(modelId) || (remoteModelId != null && ANTHROPIC_FAMILY.test(remoteModelId))) {
    return 'anthropic';
  }
  return 'openai';
}
