// ============================================================
// @berry-agent/config — SDK Config Schema
// ============================================================
//
// The runtime config type is derived from this schema. The loader should not
// grow its own parser: package namespaces own their schemas, and this package
// composes them into the single SDK config contract.

import { z } from 'zod';
import { modelsNamespaceSchema } from '@berry-agent/models';
import { safeNamespaceSchema } from '@berry-agent/safe';
import { toolsCommonNamespaceSchema } from '@berry-agent/tools-common';
import { observeNamespaceSchema } from '@berry-agent/observe';

export const BERRY_SDK_CONFIG_FIELDS = [
  'models',
  'safe',
  'tools-common',
  'observe',
] as const;

export const berrySdkConfigSchema = z.object({
  models: modelsNamespaceSchema,
  safe: safeNamespaceSchema.optional(),
  'tools-common': toolsCommonNamespaceSchema.optional(),
  observe: observeNamespaceSchema.optional(),
}).strict();

export type BerrySdkConfig = z.infer<typeof berrySdkConfigSchema>;
