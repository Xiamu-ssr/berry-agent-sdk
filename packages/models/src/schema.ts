// ============================================================
// @berry-agent/models — Zod Schema for SDK Config Namespace
// ============================================================
// Exported so @berry-agent/config can compose a full BerrySdkConfig
// schema from per-package namespace schemas.

import { z } from 'zod';
import type { ProviderType } from '@berry-agent/core';
import type { ModelBinding, ModelsRegistry, ProviderInstance } from './types.js';

/** Zod schema for core provider protocol kinds. */
export const providerTypeSchema = z.enum(['anthropic', 'openai']) satisfies z.ZodType<ProviderType>;

/** Per-protocol base URLs. At least one must be set. */
export const providerEndpointsSchema = z.object({
  anthropic: z.string().min(1).optional(),
  openai: z.string().min(1).optional(),
}).refine((e) => Boolean(e.anthropic || e.openai), {
  message: 'at least one of anthropic/openai endpoint is required',
});

/** Zod schema for a single provider reference inside a model binding. */
export const modelProviderRefSchema = z.object({
  providerId: z.string().min(1, 'must be a non-empty string'),
  remoteModelId: z.string().optional(),
});

/** Zod schema for a model binding (Layer 2). */
export const modelBindingSchema = z.object({
  id: z.string().min(1).optional(), // key serves as id, so field is optional in config
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  providers: z.array(modelProviderRefSchema, {
    required_error: 'must be a non-empty array',
    invalid_type_error: 'must be a non-empty array',
  }).min(1, 'must be a non-empty array'),
});

/** Zod schema for a provider instance (Layer 1). */
export const providerInstanceSchema = z.object({
  id: z.string().min(1).optional(), // key serves as id
  presetId: z.string({
    required_error: 'must be a non-empty string',
    invalid_type_error: 'must be a non-empty string',
  }).min(1, 'must be a non-empty string'),
  apiKey: z.string({
    required_error: 'must be a string',
    invalid_type_error: 'must be a string',
  }),
  endpoints: providerEndpointsSchema.optional(),
  knownModels: z.array(z.string()).optional(),
  label: z.string().optional(),
});

const rawModelsNamespaceSchema = z.object({
  providers: z.record(z.string(), providerInstanceSchema),
  models: z.record(z.string(), modelBindingSchema),
  tiers: z.record(z.string(), z.string()),
})
  .superRefine((registry, ctx) => {
    for (const [providerId, provider] of Object.entries(registry.providers)) {
      if (provider.id !== undefined && provider.id !== providerId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providers', providerId, 'id'],
          message: `must match provider key "${providerId}"`,
        });
      }
    }

    for (const [modelId, binding] of Object.entries(registry.models)) {
      if (binding.id !== undefined && binding.id !== modelId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', modelId, 'id'],
          message: `must match model key "${modelId}"`,
        });
      }
    }

    for (const [modelId, binding] of Object.entries(registry.models)) {
      for (const [index, ref] of binding.providers.entries()) {
        if (!(ref.providerId in registry.providers)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['models', modelId, 'providers', index, 'providerId'],
            message: `references unknown providerId "${ref.providerId}"`,
          });
        }
      }
    }

    for (const [tier, modelId] of Object.entries(registry.tiers)) {
      if (!(modelId in registry.models)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', tier],
          message: `points at unknown model "${modelId}"`,
        });
      }
    }
  })
  .transform((registry): ModelsRegistry => ({
    providers: withRecordIds<ProviderInstance>(registry.providers),
    models: withRecordIds<ModelBinding>(registry.models),
    tiers: registry.tiers,
  }));

/** Zod schema for the complete `models` namespace in berry-sdk.json. */
export const modelsNamespaceSchema = rawModelsNamespaceSchema;

/** Inferred TS type from the zod schema (matches ModelsRegistry). */
export type ModelsNamespaceConfig = z.infer<typeof modelsNamespaceSchema>;

function withRecordIds<T extends { id: string }>(
  records: Record<string, Omit<T, 'id'> & { id?: string }>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(records).map(([id, value]) => [id, { ...value, id }]),
  ) as Record<string, T>;
}
