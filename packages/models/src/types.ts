// ============================================================
// @berry-agent/models — Shared Types
// ============================================================
// Three layers of provider/model configuration, all referenced by ID:
//
//   Layer 3  Tier        → references Layer 2 by modelId
//   Layer 2  ModelBinding → references Layer 1 by providerId
//   Layer 1  ProviderInstance → owns the real apiKey + baseUrl
//
// Higher layers NEVER copy credentials; they reference the layer below.

import type { ProviderType } from '@berry-agent/core';

/**
 * The wire protocol a call speaks. Identical to core's ProviderType, named
 * here to read as "protocol" at the model layer. A model's protocol is NOT
 * configured — it is inferred from the model family (see modelProtocolFamily):
 * claude/opus/sonnet/haiku → 'anthropic', everything else → 'openai'.
 */
export type WireProtocol = ProviderType;

/**
 * Per-protocol base URLs for a provider channel. A vendor may speak one or
 * both protocols at different URLs (e.g. zenmux serves anthropic at
 * /api/anthropic and openai at /api/v1). The resolver picks the endpoint that
 * matches the model's family. At least one must be set.
 */
export interface ProviderEndpoints {
  anthropic?: string;
  openai?: string;
}

// ──────────────────────────────────────────────
// Tier
// ──────────────────────────────────────────────

/**
 * A tier identifier — a short, semantic alias agents request as `tier:X`.
 *
 * This is an OPEN vocabulary, not a fixed enum: the operator's models
 * template defines which tiers exist (`strong`, `fast`, `cheap`, …) and the
 * registry's `tiers` map is the single source of truth. Code that needs to
 * know "is this tier configured?" checks `registry.tiers[id]`, never a
 * hardcoded list. The alias is `string` to document intent while staying
 * faithful to the template-driven model.
 */
export type TierId = string;

// ──────────────────────────────────────────────
// Layer 1 — Provider Instance + Preset
// ──────────────────────────────────────────────

/**
 * Preset descriptor for a known provider (anthropic / openai / moonshot …).
 * Pure metadata — no secrets. Consumers combine this with a user-supplied
 * apiKey to make a working ProviderInstance.
 *
 * Protocol is NOT a preset field: a channel declares its per-protocol
 * `endpoints`, and the resolver chooses the one matching the model's family.
 */
export interface ProviderPreset {
  /** Stable registry id (e.g. 'anthropic', 'moonshot', 'zenmux'). */
  id: string;
  /** Human name for UI. */
  name: string;
  /**
   * Per-protocol base URLs. A channel that speaks both protocols (e.g. zenmux)
   * sets both; a single-protocol vendor sets one. At least one is required.
   */
  endpoints: ProviderEndpoints;
  /**
   * Fallback list of model ids when `listModels` can't or doesn't work.
   * Best-effort: the UI should still offer a refresh button that hits
   * the live endpoint.
   */
  knownModels: string[];
  /** Optional URL for the dashboard / docs the user needs to grab their key from. */
  apiKeyDocsUrl?: string;
  /**
   * Endpoint to dynamically list models. Relative to the base URL chosen for
   * the probed protocol. When absent, the preset relies on `knownModels` only.
   */
  listModelsPath?: string;
}

/** Special preset id used to represent a raw user-entered provider (escape hatch). */


/**
 * A configured provider instance — the only layer that holds credentials.
 * Layer 2 Models reference this by `id`.
 */
export interface ProviderInstance {
  /** User-visible id (unique across the whole config). */
  id: string;
  /** Which preset this instance is based on, or RAW_PRESET_ID. */
  presetId: string;
  /** API key (resolved — consumers may substitute a CredentialStore key at load time). */
  apiKey: string;
  /**
   * Override the preset's per-protocol endpoints, or required (≥1) when
   * presetId === '__raw__'. The resolver reads the endpoint matching the
   * model's family.
   */
  endpoints?: ProviderEndpoints;
  /**
   * User-supplied model list for raw presets. For known presets, leave empty
   * and let `listModels(preset, apiKey)` populate dynamically.
   */
  knownModels?: string[];
  /** Optional friendly name for UI (defaults to id). */
  label?: string;
}

// ──────────────────────────────────────────────
// Layer 2 — Model Binding
// ──────────────────────────────────────────────

/**
 * One provider entry inside a model binding. Just a reference — no key here.
 */
export interface ModelProviderRef {
  /** References ProviderInstance.id */
  providerId: string;
  /**
   * The upstream model id for this specific provider, when different from
   * the user-facing id. Example: model "claude-opus-4.7" when routed through
   * zenmux is actually requested as "anthropic/claude-opus-4.7".
   */
  remoteModelId?: string;
}

/**
 * A model-first aggregate. The canonical id is what the rest of the system
 * (tiers, agents, UI) refers to. Multiple providers can back the same model;
 * the runtime resolver walks them in order until one succeeds.
 */
export interface ModelBinding {
  /** User-visible model id (unique across config). */
  id: string;
  /** Optional display label (defaults to id). */
  label?: string;
  /**
   * Maximum context window for this logical model, in tokens. This is Layer-2
   * metadata because agents and tiers depend on the model id, while failover
   * providers are just backing routes for that same model.
   */
  contextWindow?: number;
  /**
   * Ordered list of providers. Resolver uses `providers[0]` first; when a
   * call fails, the resolver rotates to `providers[1]`, etc. Providers
   * are equal — no cooldowns, no scores — until they've all been exhausted.
   */
  providers: ModelProviderRef[];
}

// ──────────────────────────────────────────────
// Layer 3 — Tier Mapping
// ──────────────────────────────────────────────

/** Maps each TierId to a ModelBinding.id. */
export type TierConfig = Record<TierId, string>;

// ──────────────────────────────────────────────
// Complete registry (what a consumer builds/feeds us)
// ──────────────────────────────────────────────

export interface ModelsRegistry {
  /** All configured provider instances, keyed by id. */
  providers: Record<string, ProviderInstance>;
  /** All configured model bindings, keyed by id. */
  models: Record<string, ModelBinding>;
  /** Tier → model id. Partial is allowed while the user is still configuring. */
  tiers: Partial<TierConfig>;
}
