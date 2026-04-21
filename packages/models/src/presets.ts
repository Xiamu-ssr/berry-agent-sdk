// ============================================================
// @berry-agent/models — Built-in Provider Presets
// ============================================================
// Intentional minimalism: this file only describes where a provider lives
// (baseUrl + type) and a starting model list. Keys are user-supplied; model
// catalogs should be refreshed live via `listModels()` when the provider
// supports it.
//
// Adding a preset: PR-friendly, backwards compatible, data-only.

import type { ProviderPreset } from './types.js';

/** Special preset id used to represent a raw user-entered provider (escape hatch). */
export const RAW_PRESET_ID = '__raw__' as const;

/** Built-in provider presets keyed by id. */
export const BUILTIN_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
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
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
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
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
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
    type: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/',
    apiKeyDocsUrl: 'https://platform.moonshot.cn/console/api-keys',
    knownModels: [
      'kimi-k2.6',
      'kimi-k2.6-preview',
    ],
  },

  glm: {
    id: 'glm',
    name: 'ZhipuAI GLM',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
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
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    listModelsPath: '/models',
    apiKeyDocsUrl: 'https://platform.deepseek.com/api_keys',
    knownModels: [
      'deepseek-chat',
      'deepseek-reasoner',
    ],
  },

  zenmux: {
    id: 'zenmux',
    name: 'ZenMux (Anthropic-compatible)',
    type: 'anthropic',
    baseUrl: 'https://zenmux.ai/api/anthropic',
    apiKeyDocsUrl: 'https://zenmux.ai/dashboard',
    knownModels: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5',
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'anthropic',
    baseUrl: 'https://openrouter.ai/api',
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
