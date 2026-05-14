// ============================================================
// @berry-agent/safe — SDK Config Integration
// ============================================================
// Reads safe namespace defaults from a berry-sdk.json file, producing the
// modelRef + registry + optional override fields needed by
// createClassifierGuard(). This module intentionally does not import
// @berry-agent/config: config imports safe's schema, so importing it back from
// safe creates a package cycle and makes TypeScript pull safe/dist into its
// own build graph.

import type { ClassifierConfig } from './types.js';
import { readFileSync } from 'node:fs';
import type { ModelsRegistry } from '@berry-agent/models';
import { safeNamespaceSchema } from './schema.js';

interface RawSdkConfig {
  models?: ModelsRegistry;
  safe?: unknown;
}

/**
 * Derive classifier config fields from an SDK config file.
 *
 * Reads `safe.classifier.*` and `models` from berry-sdk.json.
 * Throws if the file is missing or `safe.classifier.model` is absent.
 */
export function classifierConfigFromSdk(
  sdkConfigPath: string,
): Pick<
  ClassifierConfig,
  | 'modelRef'
  | 'registry'
  | 'blockRules'
  | 'allowExceptions'
  | 'skipStage2'
  | 'maxConsecutiveDenials'
  | 'maxTotalDenials'
> {
  const sdkConfig = readSdkConfig(sdkConfigPath);
  const safeConfig = sdkConfig.safe === undefined ? undefined : safeNamespaceSchema.parse(sdkConfig.safe);
  const modelRef = safeConfig?.classifier?.model;
  if (!modelRef) {
    throw new Error(
      `safe.classifier.model is required in SDK config "${sdkConfigPath}", ` +
        'but it was not found. Add it or pass modelRef + registry directly.',
    );
  }
  return {
    modelRef,
    registry: sdkConfig.models,
    blockRules: safeConfig?.classifier?.blockRules as string[] | undefined,
    allowExceptions: safeConfig?.classifier?.allowExceptions as string[] | undefined,
    skipStage2: safeConfig?.classifier?.skipStage2,
    maxConsecutiveDenials: safeConfig?.classifier?.maxConsecutiveDenials,
    maxTotalDenials: safeConfig?.classifier?.maxTotalDenials,
  };
}

function readSdkConfig(path: string): RawSdkConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read SDK config "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse SDK config "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`SDK config "${path}" must be a JSON object`);
  }
  const value = parsed as RawSdkConfig;
  if (!value.models || typeof value.models !== 'object') {
    throw new Error(`models namespace is required in SDK config "${path}"`);
  }
  return value;
}
