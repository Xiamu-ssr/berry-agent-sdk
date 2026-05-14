// ============================================================
// @berry-agent/observe — Zod Schema for SDK Config Namespace
// ============================================================
// Exported so @berry-agent/config can compose a full BerrySdkConfig
// schema from per-package namespace schemas.

import { z } from 'zod';

/** Zod schema for the `observe` namespace in berry-sdk.json. */
export const observeNamespaceSchema = z.object({
  dbPath: z.string().optional(),
  retentionDays: z.number().int().min(0).optional(),
  storeFullContent: z.boolean().optional(),
});

/** Inferred TS type from the zod schema. */
export type ObserveNamespaceConfig = z.infer<typeof observeNamespaceSchema>;