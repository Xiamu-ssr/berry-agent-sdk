// ============================================================
// @berry-agent/observe — Zod Schemas
// ============================================================
// Exported so @berry-agent/config and the observe REST server can share
// package-owned validation instead of duplicating query/config parsing.

import { z } from 'zod';

/** Zod schema for the `observe` namespace in berry-sdk.json. */
export const observeNamespaceSchema = z.object({
  dbPath: z.string().optional(),
  retentionDays: z.number().int().min(0).optional(),
  storeFullContent: z.boolean().optional(),
});

/** Inferred TS type from the zod schema. */
export type ObserveNamespaceConfig = z.infer<typeof observeNamespaceSchema>;

const observeQueryStringSchema = z.preprocess(
  firstQueryValue,
  z.string().min(1).optional(),
);

const observeOptionalIntQuerySchema = z.preprocess(
  (value) => {
    const first = firstQueryValue(value);
    if (first === undefined || first === '') return undefined;
    const numeric = Number(first);
    return Number.isFinite(numeric) ? numeric : undefined;
  },
  z.number().int().nonnegative().optional().catch(undefined),
);

export const observeFilterQuerySchema = z.object({
  sessionId: observeQueryStringSchema,
  agentId: observeQueryStringSchema,
  turnId: observeQueryStringSchema,
}).strip();

export const observeCostTrendQuerySchema = z.object({
  days: intQueryWithDefault(30),
}).strip();

export const observeGuardDecisionQuerySchema = observeFilterQuerySchema.extend({
  llmCallId: observeQueryStringSchema,
  toolName: observeQueryStringSchema,
  limit: intQueryWithDefault(100),
}).strip();

export const observeCompactionQuerySchema = z.object({
  sessionId: observeQueryStringSchema,
  agentId: observeQueryStringSchema,
}).strip();

export const observeCompactionListQuerySchema = observeCompactionQuerySchema.extend({
  limit: intQueryWithDefault(100),
}).strip();

export const observeInferenceListQuerySchema = observeFilterQuerySchema.extend({
  model: observeQueryStringSchema,
  since: observeOptionalIntQuerySchema,
  until: observeOptionalIntQuerySchema,
  limit: intQueryWithDefault(50),
}).strip();

export const observeTurnListQuerySchema = z.object({
  sessionId: observeQueryStringSchema,
  agentId: observeQueryStringSchema,
  limit: intQueryWithDefault(50),
}).strip();

export const observeLimit50QuerySchema = z.object({
  limit: intQueryWithDefault(50),
}).strip();

export const observeRecentSessionsQuerySchema = z.object({
  limit: intQueryWithDefault(20),
}).strip();

export type ObserveFilterQuery = z.infer<typeof observeFilterQuerySchema>;
export type ObserveInferenceListQuery = z.infer<typeof observeInferenceListQuerySchema>;

function intQueryWithDefault(defaultValue: number): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => {
      const first = firstQueryValue(value);
      if (first === undefined || first === '') return defaultValue;
      const numeric = Number(first);
      return Number.isFinite(numeric) ? numeric : defaultValue;
    },
    z.number().int().positive().catch(defaultValue),
  );
}

function firstQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'object' && value !== null ? undefined : value;
}
