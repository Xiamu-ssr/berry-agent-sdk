// ============================================================
// @berry-agent/models — Context Window Inference
// ============================================================
// Best-effort inference used by managed runtimes before a provider has
// reported concrete token usage. Explicit Layer-2 model metadata wins; string
// heuristics are only fallbacks for partially configured model bindings.

import type { ModelsRegistry } from './types.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function inferContextWindow(modelSpec: string | undefined, registry: ModelsRegistry): number {
  const modelId = resolveModelId(modelSpec, registry);
  const configuredWindow = modelId ? registry.models?.[modelId]?.contextWindow : undefined;
  if (isValidContextWindow(configuredWindow)) return configuredWindow;

  const signals = collectModelSignals(modelSpec, registry).map((value) => value.toLowerCase());

  if (signals.some((value) => value.includes('gpt-5'))) return 100_000;
  if (signals.some((value) => value.includes('claude'))) return 200_000;
  if (signals.some((value) => value.includes('kimi'))) return 128_000;
  if (signals.some((value) => value.includes('deepseek'))) return 128_000;
  if (signals.some((value) => value.includes('glm'))) return 128_000;

  return DEFAULT_CONTEXT_WINDOW;
}

function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 4_000 && value <= 10_000_000;
}

function collectModelSignals(modelSpec: string | undefined, registry: ModelsRegistry): string[] {
  const out = new Set<string>();
  if (modelSpec) out.add(modelSpec);

  const modelId = resolveModelId(modelSpec, registry);
  if (modelId) out.add(modelId);

  const binding = modelId ? registry.models?.[modelId] : undefined;
  for (const ref of binding?.providers ?? []) {
    out.add(ref.providerId);
    if (ref.remoteModelId) out.add(ref.remoteModelId);
    const provider = registry.providers?.[ref.providerId];
    if (provider?.presetId) out.add(provider.presetId);
    if (provider?.label) out.add(provider.label);
  }

  return [...out];
}

function resolveModelId(modelSpec: string | undefined, registry: ModelsRegistry): string | undefined {
  if (!modelSpec) return undefined;
  if (modelSpec.startsWith('tier:')) {
    return registry.tiers?.[modelSpec.slice('tier:'.length) as keyof typeof registry.tiers];
  }
  if (modelSpec.startsWith('model:')) return modelSpec.slice('model:'.length);
  return modelSpec;
}
