// ============================================================
// @berry-agent/models — Zod Schema for SDK Config Namespace
// ============================================================
// Exported so @berry-agent/config can compose a full BerrySdkConfig
// schema from per-package namespace schemas.

import { z } from 'zod';

/** Zod schema for a single provider reference inside a model binding. */
export const modelProviderRefSchema = z.object({
  providerId: z.string().min(1),
  remoteModelId: z.string().optional(),
});

/** Zod schema for a model binding (Layer 2). */
export const modelBindingSchema = z.object({
  id: z.string().min(1).optional(), // key serves as id, so field is optional in config
  label: z.string().optional(),
  providers: z.array(modelProviderRefSchema).min(1),
});

/** Zod schema for a provider instance (Layer 1). */
export const providerInstanceSchema = z.object({
  id: z.string().min(1).optional(), // key serves as id
  presetId: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  type: z.string().optional(),
  knownModels: z.array(z.string()).optional(),
  label: z.string().optional(),
});

/** Zod schema for the complete `models` namespace in berry-sdk.json. */
export const modelsNamespaceSchema = z.object({
  providers: z.record(z.string(), providerInstanceSchema),
  models: z.record(z.string(), modelBindingSchema),
  tiers: z.record(z.string(), z.string()),
});

/** Inferred TS type from the zod schema (matches ModelsRegistry). */
export type ModelsNamespaceConfig = z.infer<typeof modelsNamespaceSchema>;