// ============================================================
// @berry-agent/models — Public API
// ============================================================

// Types (3 layers + registry)
export type {
  TierId,
  ProviderPreset,
  ProviderInstance,
  ModelProviderRef,
  ModelBinding,
  TierConfig,
  ModelsRegistry,
} from './types.js';

// Presets (Layer 1 catalog)
export {
  BUILTIN_PRESETS,
  listBuiltinPresets,
  getPreset,
  RAW_PRESET_ID,
} from './presets.js';

// listModels (dynamic Layer 1 catalog refresh)
export { listModels } from './list-models.js';
export type { ListModelsOptions, ListModelsResult } from './list-models.js';

// Resolvers (Layer 2 + Layer 3 → core ProviderResolver)
export {
  createModelResolver,
  createTierResolver,
  buildProviderConfig,
  ModelResolveError,
} from './resolver.js';
export type { CreateModelResolverOptions, ModelResolverWithSnapshot } from './resolver.js';

// Resolver snapshot (typed observability for provider rotation state)
export { ModelResolverSnapshot } from './resolver-snapshot.js';
export type { ModelResolverSnapshotData, ResolverErrorSummary } from './resolver-snapshot.js';

// Model reference string parser (tier:X / model:X / bare model id)
export { parseModelRef } from './parse.js';
export type { ModelRef } from './parse.js';

// Top-level convenience
export { selectProvider } from './select.js';
export type { SelectProviderOptions } from './select.js';
export { inferContextWindow } from './context-window.js';

// Zod schema for SDK config namespace
export {
  modelsNamespaceSchema,
  modelProviderRefSchema,
  modelBindingSchema,
  providerInstanceSchema,
  providerTypeSchema,
} from './schema.js';
export type { ModelsNamespaceConfig } from './schema.js';
