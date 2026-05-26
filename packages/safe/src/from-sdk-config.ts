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
import { resolveClassifierConfig } from './classifier-config.js';

interface RawSdkConfig {
  models?: ModelsRegistry;
  safe?: unknown;
}

interface ValidSdkConfig {
  models: ModelsRegistry;
  safe?: unknown;
}

/**
 * Derive classifier config fields from an SDK config file.
 *
 * Reads `safe.classifier.*` and `models` from berry-sdk.json. If
 * `safe.classifier.model` is absent, the safe package default (`tier:fast`)
 * is used when that tier exists.
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
  const resolved = resolveClassifierConfig({ safe: safeConfig, registry: sdkConfig.models });
  if (!resolved) {
    throw new Error(
      `safe.classifier could not be resolved from SDK config "${sdkConfigPath}". ` +
        'Set safe.classifier.model, configure models.tiers.fast, or pass modelRef + registry directly.',
    );
  }
  return resolved;
}

function readSdkConfig(path: string): ValidSdkConfig {
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
  return {
    models: value.models,
    safe: value.safe,
  };
}
