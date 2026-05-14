// ============================================================
// @berry-agent/tools-common — Zod Schema for SDK Config Namespace
// ============================================================
// Exported so @berry-agent/config can compose a full BerrySdkConfig
// schema from per-package namespace schemas.

import { z } from 'zod';

/** Zod schema for the `tools-common` namespace in berry-sdk.json. */
export const toolsCommonNamespaceSchema = z.object({
  tavily: z.object({
    apiKey: z.string().min(1),
  }).optional(),
  webFetch: z.object({
    trustedDomains: z.array(z.string()),
  }).optional(),
});

/** Inferred TS type from the zod schema. */
export type ToolsCommonNamespaceConfig = z.infer<typeof toolsCommonNamespaceSchema>;