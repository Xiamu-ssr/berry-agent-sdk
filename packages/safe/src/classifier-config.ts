// ============================================================
// @berry-agent/safe — Classifier config resolution
// ============================================================
// Shared policy for turning the SDK safe namespace into a concrete classifier
// configuration. Host products should use this instead of hard-coding
// `tier:fast` in product code.

import type { ModelsRegistry } from '@berry-agent/models';
import type { ClassifierConfig } from './types.js';
import type { SafeNamespaceConfig } from './schema.js';

/** SDK default classifier model reference. Products may override it. */
export const DEFAULT_CLASSIFIER_MODEL_REF = 'tier:fast' as const;

export interface ResolveClassifierConfigOptions {
  safe?: SafeNamespaceConfig;
  registry: ModelsRegistry;
  /** Defaults to {@link DEFAULT_CLASSIFIER_MODEL_REF}. */
  defaultModelRef?: string;
}

export interface ResolvedClassifierConfig
  extends Pick<
    ClassifierConfig,
    | 'blockRules'
    | 'allowExceptions'
    | 'skipStage2'
    | 'maxConsecutiveDenials'
    | 'maxTotalDenials'
  > {
  modelRef: string;
  registry: ModelsRegistry;
}

/**
 * Resolve `safe.classifier` into a concrete classifier configuration.
 *
 * Policy:
 * - `safe.classifier.enabled === false` disables the classifier.
 * - `safe.classifier.model` wins when set.
 * - otherwise the SDK default is `tier:fast`, but only when the registry has
 *   that tier. If the tier is absent, return null so callers can fall back to
 *   HITL instead of creating a dangling resolver.
 */
export function resolveClassifierConfig(
  options: ResolveClassifierConfigOptions,
): ResolvedClassifierConfig | null {
  const classifier = options.safe?.classifier;
  if (classifier?.enabled === false) return null;

  const configuredModel = classifier?.model?.trim();
  const defaultModel = options.defaultModelRef ?? DEFAULT_CLASSIFIER_MODEL_REF;
  const modelRef = configuredModel || (modelRefAvailable(defaultModel, options.registry) ? defaultModel : undefined);
  if (!modelRef) return null;

  return {
    modelRef,
    registry: options.registry,
    blockRules: classifier?.blockRules,
    allowExceptions: classifier?.allowExceptions,
    skipStage2: classifier?.skipStage2,
    maxConsecutiveDenials: classifier?.maxConsecutiveDenials,
    maxTotalDenials: classifier?.maxTotalDenials,
  };
}

function modelRefAvailable(modelRef: string, registry: ModelsRegistry): boolean {
  if (modelRef.startsWith('tier:')) {
    const tier = modelRef.slice('tier:'.length);
    return Boolean(registry.tiers[tier as keyof typeof registry.tiers]);
  }
  if (modelRef.startsWith('model:')) {
    const model = modelRef.slice('model:'.length);
    return Boolean(registry.models[model]);
  }
  return Boolean(registry.models[modelRef]);
}
