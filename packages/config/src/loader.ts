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
import { errorMessage } from '@berry-agent/core';
import {
  BERRY_SDK_CONFIG_FIELDS,
  berrySdkConfigSchema,
} from './schema.js';
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
      `loadSdkConfig: failed to read "${path}": ${errorMessage(err)}`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SdkConfigError(
      `loadSdkConfig: "${path}" is not valid JSON — ${errorMessage(err)}`,
      path,
    );
  }

  return validateConfig(parsed, path);
}

// ──────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────

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
  const result = berrySdkConfigSchema.safeParse(value);
  if (!result.success) {
    throw new SdkConfigError(
      formatConfigError(path, result.error.issues),
      path,
    );
  }
  return result.data;
}

function formatConfigError(configPath: string, issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (first && first.code === z.ZodIssueCode.invalid_type && first.path.length === 0) {
    return `loadSdkConfig: "${configPath}" must be a JSON object at the top level`;
  }

  if (first && first.code === z.ZodIssueCode.unrecognized_keys && first.path.length === 0) {
    const keyList = first.keys.map((key) => `"${key}"`).join(', ');
    return `loadSdkConfig: "${configPath}" has unknown top-level field ${keyList}. ` +
      `Allowed: ${BERRY_SDK_CONFIG_FIELDS.join(', ')}`;
  }

  if (first && first.code === z.ZodIssueCode.invalid_type) {
    const path = formatIssuePath(first.path);
    if (path === 'models' && first.received === 'undefined') {
      return `loadSdkConfig: "${configPath}" is missing required field "models" (must be an object)`;
    }
    if (
      (path === 'models.providers' || path === 'models.models' || path === 'models.tiers') &&
      first.expected === 'object'
    ) {
      return `loadSdkConfig: "${configPath}" has invalid "${path}" (expected object)`;
    }
  }

  const details = issues.map(formatIssue).join('; ');
  return `loadSdkConfig: "${configPath}" — ${details}`;
}

function formatIssue(issue: z.ZodIssue): string {
  const path = formatIssuePath(issue.path);
  if (!path) return issue.message;

  if (issue.code === z.ZodIssueCode.invalid_type && issue.expected === 'object') {
    if (/^models\.models\.[^.]+\.providers\.\d+$/.test(path)) {
      return `${path} entries must be objects with a string "providerId"`;
    }
    return `${path} must be an object`;
  }

  return `${path} ${issue.message}`;
}

function formatIssuePath(path: Array<string | number>): string {
  return path.map(String).join('.');
}
