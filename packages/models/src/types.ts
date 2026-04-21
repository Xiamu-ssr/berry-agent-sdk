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

// ──────────────────────────────────────────────
// Tier
// ──────────────────────────────────────────────

/**
 * Internal tier identifier used by code / APIs / LLM-facing text.
 * Keep these short, English, and semantic — the UI layer picks its
 * own display label ("传说 · Strong" etc.).
 */
export type TierId = 'strong' | 'balanced' | 'fast';

export const TIER_IDS: readonly TierId[] = ['strong', 'balanced', 'fast'] as const;

// ──────────────────────────────────────────────
// Layer 1 — Provider Instance + Preset
// ──────────────────────────────────────────────

/**
 * Preset descriptor for a known provider (anthropic / openai / moonshot …).
 * Pure metadata — no secrets. Consumers combine this with a user-supplied
 * apiKey to make a working ProviderInstance.
 */
export interface ProviderPreset {
  /** Stable registry id (e.g. 'anthropic', 'moonshot', 'glm'). */
  id: string;
  /** Human name for UI. */
  name: string;
  /** Berry-core provider type this preset wires up. */
  type: ProviderType;
  /** Default base URL. Can be overridden on the ProviderInstance. */
  baseUrl: string;
  /**
   * Fallback list of model ids when `listModels` can't or doesn't work.
   * Best-effort: the UI should still offer a refresh button that hits
   * the live endpoint.
   */
  knownModels: string[];
  /** Optional URL for the dashboard / docs the user needs to grab their key from. */
  apiKeyDocsUrl?: string;
  /**
   * Endpoint to dynamically list models. Relative to baseUrl.
   * When absent, the preset relies on `knownModels` only.
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
  /** Override the preset's baseUrl, or required when presetId === '__raw__'. */
  baseUrl?: string;
  /** Provider type (required when presetId === '__raw__', ignored otherwise). */
  type?: ProviderType;
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
