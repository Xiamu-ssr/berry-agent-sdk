// ============================================================
// @berry-agent/models — Built-in Provider Presets
// ============================================================
// Intentional minimalism: a preset only describes where a provider lives
// (per-protocol `endpoints`) and a starting model list. Keys are user-supplied;
// model catalogs should be refreshed live via `listModels()` when supported.
//
// Protocol is NOT a preset field — it's inferred per-model (see protocol.ts).
// A channel that speaks both protocols (zenmux) sets both endpoints; the
// resolver picks the one matching the requested model's family.
//
// Adding a preset should be data-only.

import type { ProviderPreset } from './types.js';

/** Special preset id used to represent a raw user-entered provider (escape hatch). */
export const RAW_PRESET_ID = '__raw__' as const;

/** Built-in provider presets keyed by id. */
export const BUILTIN_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    endpoints: { anthropic: 'https://api.anthropic.com' },
    listModelsPath: '/v1/models',
    apiKeyDocsUrl: 'https://console.anthropic.com/settings/keys',
    knownModels: [
      'claude-opus-4-5-20260401',
      'claude-sonnet-4-5-20260401',
      'claude-haiku-4-5-20260401',
    ],
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    endpoints: { openai: 'https://api.openai.com/v1' },
    listModelsPath: '/models',
    apiKeyDocsUrl: 'https://platform.openai.com/api-keys',
    knownModels: [
      'gpt-5',
      'gpt-5-mini',
      'o4',
      'o4-mini',
    ],
  },

  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    endpoints: { openai: 'https://api.moonshot.cn/v1' },
    listModelsPath: '/models',
    apiKeyDocsUrl: 'https://platform.moonshot.cn/console/api-keys',
    knownModels: [
      'kimi-k2.6',
      'kimi-k2.6-preview',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
    ],
  },

  'moonshot-coding': {
    id: 'moonshot-coding',
    name: 'Moonshot Coding Plan (subscription)',
    endpoints: { anthropic: 'https://api.kimi.com/coding/' },
    apiKeyDocsUrl: 'https://platform.moonshot.cn/console/api-keys',
    knownModels: [
      'kimi-k2.6',
      'kimi-k2.6-preview',
    ],
  },

  glm: {
    id: 'glm',
    name: 'ZhipuAI GLM',
    endpoints: { openai: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    apiKeyDocsUrl: 'https://bigmodel.cn/usercenter/apikeys',
    knownModels: [
      'glm-5.1',
      'glm-4.6',
      'glm-4.5-flash',
    ],
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    endpoints: { openai: 'https://api.deepseek.com/v1' },
    listModelsPath: '/models',
    apiKeyDocsUrl: 'https://platform.deepseek.com/api_keys',
    knownModels: [
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },

  zenmux: {
    id: 'zenmux',
    name: 'ZenMux',
    // One vendor channel, both protocols at different URLs. The resolver
    // routes Claude models to the anthropic endpoint (restoring prompt cache)
    // and everything else to the openai endpoint.
    endpoints: {
      anthropic: 'https://zenmux.ai/api/anthropic',
      openai: 'https://zenmux.ai/api/v1',
    },
    listModelsPath: '/v1/models',
    apiKeyDocsUrl: 'https://zenmux.ai/dashboard',
    knownModels: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.1',
      'google/gemini-3.1-pro-preview',
      'moonshot/kimi-k2.6',
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoints: {
      anthropic: 'https://openrouter.ai/api',
      openai: 'https://openrouter.ai/api/v1',
    },
    listModelsPath: '/v1/models',
    apiKeyDocsUrl: 'https://openrouter.ai/keys',
    knownModels: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'z-ai/glm-5.1',
      'moonshot/kimi-k2.6',
    ],
  },
};

/** Snapshot list of built-in presets. */
export function listBuiltinPresets(): ProviderPreset[] {
  return Object.values(BUILTIN_PRESETS);
}

/** Look up a preset by id. Returns undefined for unknown ids. */
export function getPreset(id: string): ProviderPreset | undefined {
  return BUILTIN_PRESETS[id];
}
