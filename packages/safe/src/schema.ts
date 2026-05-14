// ============================================================
// @berry-agent/safe — Zod Schema for SDK Config Namespace
// ============================================================
// Exported so @berry-agent/config can compose a full BerrySdkConfig
// schema from per-package namespace schemas.

import { z } from 'zod';

/** Zod schema for the `safe` namespace in berry-sdk.json. */
export const safeNamespaceSchema = z.object({
  classifier: z.object({
    model: z.string().optional(),
    blockRules: z.array(z.string()).optional(),
    allowExceptions: z.array(z.string()).optional(),
    skipStage2: z.boolean().optional(),
    maxConsecutiveDenials: z.number().int().min(0).optional(),
    maxTotalDenials: z.number().int().min(0).optional(),
  }).optional(),
});

/** Inferred TS type from the zod schema. */
export type SafeNamespaceConfig = z.infer<typeof safeNamespaceSchema>;