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

  it('returns a ProviderConfig for raw:', () => {
    const reg = mkRegistry();
    const out = selectProvider(
      'raw:' +
        JSON.stringify({
          type: 'anthropic',
          apiKey: 'sk-raw',
          model: 'claude-opus-4.7',
          baseUrl: 'https://api.anthropic.com',
        }),
      reg,
    );
    expect('resolve' in out).toBe(false);
    expect((out as any).apiKey).toBe('sk-raw');
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
});
