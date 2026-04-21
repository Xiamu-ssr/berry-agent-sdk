// ============================================================
// @berry-agent/models — selectProvider()
// ============================================================
// Top-level convenience: given a ModelsRegistry + an agent's "model" string,
// return something core can consume as AgentConfig.provider.
//
//   tier:X   → ProviderResolver (Layer 3 → Layer 2)
//   model:X  → ProviderResolver (Layer 2)
//   raw:...  → ProviderConfig   (bypasses models entirely)
//
// berry-claw wires this into its agent-manager so user config strings map
// onto whichever of core's two accepted provider shapes is appropriate.

import type { ProviderInput, ProviderConfig, ProviderResolver } from '@berry-agent/core';
import type { ModelsRegistry } from './types.js';
import { parseModelRef } from './parse.js';
import { createModelResolver, createTierResolver, type CreateModelResolverOptions } from './resolver.js';

export interface SelectProviderOptions extends CreateModelResolverOptions {
  /** Custom parser override (advanced). Defaults to parseModelRef(). */
  parse?: (spec: string) => ReturnType<typeof parseModelRef>;
}

/** Resolve a model string into a core-compatible ProviderInput. */
export function selectProvider(
  spec: string,
  registry: ModelsRegistry,
  options: SelectProviderOptions = {},
): ProviderInput {
  const ref = (options.parse ?? parseModelRef)(spec);

  switch (ref.kind) {
    case 'raw':
      return ref.config satisfies ProviderConfig;

    case 'model': {
      const binding = registry.models[ref.modelId];
      if (!binding) {
        throw new Error(
          `Model "${ref.modelId}" is not configured. Check your registry.models or switch to raw:.`,
        );
      }
      return createModelResolver(binding, registry, options) satisfies ProviderResolver;
    }

    case 'tier':
      return createTierResolver(ref.tier, registry, options) satisfies ProviderResolver;
  }
}
