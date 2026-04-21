// ============================================================
// @berry-agent/models — Resolvers (Layer 2 + Layer 3)
// ============================================================
// Translates Layer 2 (ModelBinding) or Layer 3 (TierConfig) into a core
// ProviderResolver. Policy: providers are equal; on error rotate to the next;
// when the whole list is exhausted, surface the last error. Per-session
// stickiness means new sessions reset the rotation pointer to 0.

import type { ProviderConfig, ProviderResolver } from '@berry-agent/core';
import type {
  ModelBinding,
  ModelProviderRef,
  ModelsRegistry,
  ProviderInstance,
  TierId,
} from './types.js';
import { getPreset, RAW_PRESET_ID } from './presets.js';

/** Error thrown when the requested model or tier cannot be built into a resolver. */
export class ModelResolveError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ModelResolveError';
  }
}

/** Compose a ProviderConfig from a ModelProviderRef + the backing ProviderInstance. */
export function buildProviderConfig(
  ref: ModelProviderRef,
  instance: ProviderInstance,
  modelId: string,
): ProviderConfig {
  const preset = getPreset(instance.presetId);

  // Raw instance: must carry baseUrl + type itself.
  if (instance.presetId === RAW_PRESET_ID) {
    if (!instance.baseUrl) {
      throw new ModelResolveError(
        `Raw provider "${instance.id}" is missing baseUrl`,
        'raw_missing_base_url',
      );
    }
    if (!instance.type) {
      throw new ModelResolveError(
        `Raw provider "${instance.id}" is missing type`,
        'raw_missing_type',
      );
    }
    return {
      type: instance.type,
      baseUrl: instance.baseUrl,
      apiKey: instance.apiKey,
      model: ref.remoteModelId ?? modelId,
    };
  }

  if (!preset) {
    throw new ModelResolveError(
      `Unknown preset "${instance.presetId}" for provider "${instance.id}"`,
      'unknown_preset',
    );
  }

  return {
    type: preset.type,
    baseUrl: instance.baseUrl ?? preset.baseUrl,
    apiKey: instance.apiKey,
    model: ref.remoteModelId ?? modelId,
  };
}

export interface CreateModelResolverOptions {
  /** Called every time we rotate to a new provider (for logging / observe). */
  onRotate?: (from: ModelProviderRef, to: ModelProviderRef, err: unknown) => void;
  /** Custom error filter. Default: only count 4xx/5xx/network as failover triggers. */
  shouldFailover?: (err: unknown, hints?: { isTransient?: boolean; statusCode?: number }) => boolean;
}

/**
 * Build a ProviderResolver from a Layer 2 ModelBinding + the surrounding
 * registry (needed to look up Layer 1 ProviderInstances).
 *
 * Semantics:
 *   - `resolve()` returns providers[pointer] composed into a ProviderConfig.
 *   - `reportError()` advances `pointer` when `shouldFailover` says so.
 *   - When `pointer` passes the last provider, resolve() will throw with the
 *     last error included.
 *   - `resetForSession()` resets pointer = 0 (per-session stickiness).
 */
export function createModelResolver(
  binding: ModelBinding,
  registry: Pick<ModelsRegistry, 'providers'>,
  options: CreateModelResolverOptions = {},
): ProviderResolver {
  if (!binding.providers || binding.providers.length === 0) {
    throw new ModelResolveError(
      `Model "${binding.id}" has no providers configured`,
      'no_providers',
    );
  }

  const shouldFailover: NonNullable<CreateModelResolverOptions['shouldFailover']> =
    options.shouldFailover ??
    ((_err: unknown, hints?: { isTransient?: boolean; statusCode?: number }) =>
      hints?.isTransient ?? true);

  let pointer = 0;
  let lastError: unknown = null;
  let exhausted = false;

  const currentRef = (): ModelProviderRef => {
    if (pointer >= binding.providers.length) {
      throw buildExhaustedError(binding, lastError);
    }
    return binding.providers[pointer]!;
  };

  return {
    id: `model:${binding.id}`,

    resolve(): ProviderConfig {
      if (exhausted) {
        throw buildExhaustedError(binding, lastError);
      }
      const ref = currentRef();
      const instance = registry.providers[ref.providerId];
      if (!instance) {
        throw new ModelResolveError(
          `Provider instance "${ref.providerId}" (for model "${binding.id}") not found in registry`,
          'missing_provider_instance',
        );
      }
      return buildProviderConfig(ref, instance, binding.id);
    },

    reportError(err, hints) {
      lastError = err;
      if (!shouldFailover(err, hints)) return;
      const from = binding.providers[pointer]!;
      pointer += 1;
      if (pointer >= binding.providers.length) {
        exhausted = true;
        return;
      }
      const to = binding.providers[pointer]!;
      options.onRotate?.(from, to, err);
    },

    resetForSession() {
      pointer = 0;
      lastError = null;
      exhausted = false;
    },
  };
}

/**
 * Build a ProviderResolver for a tier (Layer 3).
 * Tiers are thin references — we dereference to the ModelBinding and reuse
 * createModelResolver.
 */
export function createTierResolver(
  tier: TierId,
  registry: ModelsRegistry,
  options: CreateModelResolverOptions = {},
): ProviderResolver {
  const modelId = registry.tiers[tier];
  if (!modelId) {
    throw new ModelResolveError(
      `Tier "${tier}" is not configured. Configure it in Settings before use.`,
      'tier_unconfigured',
    );
  }
  const binding = registry.models[modelId];
  if (!binding) {
    throw new ModelResolveError(
      `Tier "${tier}" points at model "${modelId}" which does not exist`,
      'tier_dangling',
    );
  }
  const resolver = createModelResolver(binding, registry, options);
  return { ...resolver, id: `tier:${tier}:${modelId}` };
}

function buildExhaustedError(binding: ModelBinding, lastError: unknown): Error {
  const providerList = binding.providers.map((p) => p.providerId).join(', ');
  const msg = `All providers for model "${binding.id}" failed: [${providerList}]`;
  const err = new ModelResolveError(msg, 'all_providers_exhausted');
  (err as Error & { cause?: unknown }).cause = lastError;
  return err;
}
