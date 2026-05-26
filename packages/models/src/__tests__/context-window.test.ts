import { describe, expect, it } from 'vitest';
import { inferContextWindow } from '../context-window.js';
import type { ModelsRegistry } from '../types.js';

const registry: ModelsRegistry = {
  providers: {
    anthropic: { id: 'anthropic', presetId: 'anthropic', apiKey: 'k', label: 'Anthropic' },
    moonshot: { id: 'moonshot', presetId: 'moonshot', apiKey: 'k', label: 'Kimi' },
  },
  models: {
    claude: {
      id: 'claude',
      providers: [{ providerId: 'anthropic', remoteModelId: 'claude-sonnet-4' }],
    },
    huge: {
      id: 'huge',
      contextWindow: 512_000,
      providers: [{ providerId: 'anthropic', remoteModelId: 'claude-opus-4' }],
    },
  },
  tiers: {
    strong: 'huge',
    fast: 'claude',
  },
};

describe('inferContextWindow', () => {
  it('prefers configured model metadata over heuristics', () => {
    expect(inferContextWindow('tier:strong', registry)).toBe(512_000);
  });

  it('uses provider/model signals as fallback', () => {
    expect(inferContextWindow('model:claude', registry)).toBe(200_000);
    expect(inferContextWindow('kimi-k2', registry)).toBe(128_000);
  });

  it('falls back to the SDK default for unknown models', () => {
    expect(inferContextWindow('unknown-model', registry)).toBe(200_000);
  });
});
