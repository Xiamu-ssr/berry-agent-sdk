// ============================================================
// @berry-agent/config — loadSdkConfig
// ============================================================
//
// Contract:
//   - Sync-only. No async variant, no caching. Every call re-reads disk so
//     "the config file" and "what the SDK is using" never drift.
//   - NO default path. Hosts MUST pass a concrete path; passing `undefined`
//     is a hard error, not a silent fallback. The SDK refuses to guess.
//   - Strict shape validation — unknown top-level fields, dangling provider
//     references, and missing required sub-fields all throw `SdkConfigError`
//     with a message that names the offending path/field.
//
// Rationale: SDK-wide config is a single source of truth. Async loaders
// tempt callers to cache results and then the registry stops matching the
// file. A default path tempts products to rely on it and then two products
// in one process fight over the same location. Both footguns are removed
// by construction.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { safeNamespaceSchema } from '@berry-agent/safe';
import { toolsCommonNamespaceSchema } from '@berry-agent/tools-common';
import { observeNamespaceSchema } from '@berry-agent/observe';
import type { BerrySdkConfig } from './types.js';

/** Error raised for any failure while reading or validating an SDK config. */
export class SdkConfigError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = 'SdkConfigError';
  }
}

/**
 * Load, parse, and validate the SDK config from disk.
 *
 * @param path Absolute path to the config JSON. Required. Passing a falsy
 *             value throws — the SDK has no default location.
 */
export function loadSdkConfig(path: string): BerrySdkConfig {
  assertExplicitPath(path);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new SdkConfigError(
      `loadSdkConfig: failed to read "${path}": ${(err as Error).message}`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SdkConfigError(
      `loadSdkConfig: "${path}" is not valid JSON — ${(err as Error).message}`,
      path,
    );
  }

  return validateConfig(parsed, path);
}

// ──────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────

const ALLOWED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'models',
  'safe',
  'tools-common',
  'observe',
]);

function assertExplicitPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SdkConfigError(
      'loadSdkConfig: an explicit config file path is required — ' +
        'the SDK does not assume a default location. Pass the absolute path ' +
        'of your berry-sdk.json.',
    );
  }
}

function validateConfig(value: unknown, path: string): BerrySdkConfig {
  if (!isRecord(value)) {
    throw new SdkConfigError(
      `loadSdkConfig: "${path}" must be a JSON object at the top level`,
      path,
    );
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      throw new SdkConfigError(
        `loadSdkConfig: "${path}" has unknown top-level field "${key}". ` +
          `Allowed: ${[...ALLOWED_TOP_LEVEL_FIELDS].join(', ')}`,
        path,
      );
    }
  }

  if (!isRecord(value.models)) {
    throw new SdkConfigError(
      `loadSdkConfig: "${path}" is missing required field "models" (must be an object)`,
      path,
    );
  }

  validateModelsRegistry(value.models, path);

  // Optional namespace validation (zod schemas from each package)
  if (value.safe !== undefined) validateWithZod(safeNamespaceSchema, 'safe', value.safe, path);
  if (value['tools-common'] !== undefined) validateWithZod(toolsCommonNamespaceSchema, 'tools-common', value['tools-common'], path);
  if (value.observe !== undefined) validateWithZod(observeNamespaceSchema, 'observe', value.observe, path);

  return value as unknown as BerrySdkConfig;
}

function validateModelsRegistry(registry: Record<string, unknown>, configPath: string): void {
  // ── Required sub-objects ──
  for (const key of ['providers', 'models', 'tiers'] as const) {
    if (!isRecord(registry[key])) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" has invalid "models.${key}" (expected object)`,
        configPath,
      );
    }
  }

  const providers = registry.providers as Record<string, unknown>;
  const bindings = registry.models as Record<string, unknown>;
  const tiers = registry.tiers as Record<string, unknown>;

  // ── Providers must each be an object with at least an apiKey and presetId ──
  for (const [providerId, inst] of Object.entries(providers)) {
    if (!isRecord(inst)) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.providers.${providerId} must be an object`,
        configPath,
      );
    }
    if (typeof inst.presetId !== 'string' || inst.presetId.length === 0) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.providers.${providerId}.presetId must be a non-empty string`,
        configPath,
      );
    }
    if (typeof inst.apiKey !== 'string') {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.providers.${providerId}.apiKey must be a string`,
        configPath,
      );
    }
  }

  // ── Bindings must have non-empty providers[] referencing real providerIds ──
  for (const [modelId, binding] of Object.entries(bindings)) {
    if (!isRecord(binding)) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.models.${modelId} must be an object`,
        configPath,
      );
    }
    if (!Array.isArray(binding.providers) || binding.providers.length === 0) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.models.${modelId}.providers must be a non-empty array`,
        configPath,
      );
    }
    for (const ref of binding.providers) {
      if (!isRecord(ref) || typeof ref.providerId !== 'string') {
        throw new SdkConfigError(
          `loadSdkConfig: "${configPath}" — models.models.${modelId}.providers[] entries must be objects with a string "providerId"`,
          configPath,
        );
      }
      if (!(ref.providerId in providers)) {
        throw new SdkConfigError(
          `loadSdkConfig: "${configPath}" — models.models.${modelId} references unknown providerId "${ref.providerId}"`,
          configPath,
        );
      }
    }
  }

  // ── Tier entries must all point at existing bindings ──
  for (const [tier, modelId] of Object.entries(tiers)) {
    if (typeof modelId !== 'string' || !(modelId in bindings)) {
      throw new SdkConfigError(
        `loadSdkConfig: "${configPath}" — models.tiers.${tier} points at unknown model "${String(modelId)}"`,
        configPath,
      );
    }
  }
}

function validateWithZod(schema: z.ZodTypeAny, namespace: string, value: unknown, configPath: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${namespace}.${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new SdkConfigError(
      `loadSdkConfig: "${configPath}" — ${details}`,
      configPath,
    );
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
