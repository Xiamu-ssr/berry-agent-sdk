import { describe, it, expect } from 'vitest';
import { selectProvider } from '../select.js';
import type { ModelsRegistry } from '../types.js';

function mkRegistry(): ModelsRegistry {
  return {
    providers: {
      anthropic_main: { id: 'anthropic_main', presetId: 'anthropic', apiKey: 'sk-ant' },
    },
    models: {
      'claude-opus-4.7': {
        id: 'claude-opus-4.7',
        providers: [{ providerId: 'anthropic_main' }],
      },
    },
    tiers: { strong: 'claude-opus-4.7' },
  };
}

describe('selectProvider', () => {
  it('returns a ProviderResolver for tier:X', () => {
    const reg = mkRegistry();
    const out = selectProvider('tier:strong', reg);
    expect('resolve' in out).toBe(true);
    const cfg = (out as any).resolve();
    expect(cfg.apiKey).toBe('sk-ant');
  });

  it('returns a ProviderResolver for model:X', () => {
    const reg = mkRegistry();
    const out = selectProvider('model:claude-opus-4.7', reg);
    expect('resolve' in out).toBe(true);
  });

  it('treats bare strings as model ids', () => {
    const reg = mkRegistry();
    const out = selectProvider('claude-opus-4.7', reg);
    expect('resolve' in out).toBe(true);
  });

  it('throws for unknown model ids', () => {
    const reg = mkRegistry();
    expect(() => selectProvider('model:nonexistent', reg)).toThrow(/not configured/);
  });

  it('resolves model id from the registry key when the binding omits `id`', () => {
    // Templates authored/stored as `{ "model-x": { providers: [...] } }`
    // carry no `id` inside the binding value. The resolved ProviderConfig
    // must still get model = the key, not undefined. (Regression: an admin
    // agent on tier:strong failed at send with "model: Required" because
    // the resolved config.model was undefined.)
    const reg: ModelsRegistry = {
      providers: { zen: { id: 'zen', presetId: 'zenmux', apiKey: 'sk-x' } },
      models: {
        'anthropic/claude-opus-4.8': { providers: [{ providerId: 'zen' }] }, // no `id`
      },
      tiers: { strong: 'anthropic/claude-opus-4.8' },
    };
    const viaTier = (selectProvider('tier:strong', reg) as any).resolve();
    expect(viaTier.model).toBe('anthropic/claude-opus-4.8');
    const viaModel = (selectProvider('model:anthropic/claude-opus-4.8', reg) as any).resolve();
    expect(viaModel.model).toBe('anthropic/claude-opus-4.8');
  });
});
