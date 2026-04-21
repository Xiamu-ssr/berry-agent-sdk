import { describe, it, expect } from 'vitest';
import { createModelResolver, createTierResolver, buildProviderConfig, ModelResolveError } from '../resolver.js';
import type { ModelsRegistry } from '../types.js';
import { RAW_PRESET_ID } from '../presets.js';

function mkRegistry(): ModelsRegistry {
  return {
    providers: {
      anthropic_main: {
        id: 'anthropic_main',
        presetId: 'anthropic',
        apiKey: 'sk-anthropic',
      },
      zenmux_01: {
        id: 'zenmux_01',
        presetId: 'zenmux',
        apiKey: 'sk-zen',
      },
      corp_proxy: {
        id: 'corp_proxy',
        presetId: RAW_PRESET_ID,
        baseUrl: 'https://corp.internal/v1',
        type: 'openai',
        apiKey: 'sk-corp',
      },
    },
    models: {
      'claude-opus-4.7': {
        id: 'claude-opus-4.7',
        providers: [
          { providerId: 'anthropic_main' },
          { providerId: 'zenmux_01', remoteModelId: 'anthropic/claude-opus-4.7' },
        ],
      },
      'single-provider': {
        id: 'single-provider',
        providers: [{ providerId: 'corp_proxy', remoteModelId: 'gpt-5' }],
      },
    },
    tiers: {
      strong: 'claude-opus-4.7',
      balanced: 'single-provider',
    },
  };
}

describe('buildProviderConfig', () => {
  it('uses preset baseUrl for preset-backed instances', () => {
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'anthropic_main' },
      reg.providers.anthropic_main!,
      'claude-opus-4.7',
    );
    expect(cfg.type).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.apiKey).toBe('sk-anthropic');
    expect(cfg.model).toBe('claude-opus-4.7');
  });

  it('applies remoteModelId override', () => {
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'zenmux_01', remoteModelId: 'anthropic/claude-opus-4.7' },
      reg.providers.zenmux_01!,
      'claude-opus-4.7',
    );
    expect(cfg.model).toBe('anthropic/claude-opus-4.7');
    expect(cfg.baseUrl).toBe('https://zenmux.ai/api/anthropic');
  });

  it('requires baseUrl+type for raw providers', () => {
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'corp_proxy', remoteModelId: 'gpt-5' },
      reg.providers.corp_proxy!,
      'single-provider',
    );
    expect(cfg.baseUrl).toBe('https://corp.internal/v1');
    expect(cfg.type).toBe('openai');
  });

  it('throws when raw provider missing baseUrl', () => {
    expect(() =>
      buildProviderConfig(
        { providerId: 'bad' },
        { id: 'bad', presetId: RAW_PRESET_ID, apiKey: 'x', type: 'openai' },
        'm',
      ),
    ).toThrow(/missing baseUrl/);
  });
});

describe('createModelResolver', () => {
  it('resolves to the first provider initially', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg);
    const cfg = resolver.resolve();
    expect(cfg.apiKey).toBe('sk-anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
  });

  it('rotates on reportError (default: transient hint)', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg);
    resolver.reportError?.(new Error('boom'), { isTransient: true, statusCode: 500 });

    const cfg = resolver.resolve();
    expect(cfg.apiKey).toBe('sk-zen');
    expect(cfg.model).toBe('anthropic/claude-opus-4.7');
  });

  it('does not rotate when shouldFailover says false', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg, {
      shouldFailover: () => false,
    });
    resolver.reportError?.(new Error('ignored'));
    const cfg = resolver.resolve();
    expect(cfg.apiKey).toBe('sk-anthropic');
  });

  it('throws when all providers are exhausted', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg);
    resolver.reportError?.(new Error('1'), { isTransient: true });
    resolver.reportError?.(new Error('2'), { isTransient: true });
    expect(() => resolver.resolve()).toThrow(/All providers for model/);
  });

  it('resetForSession rewinds the pointer', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg);
    resolver.reportError?.(new Error('1'), { isTransient: true });
    expect(resolver.resolve().apiKey).toBe('sk-zen');
    resolver.resetForSession?.('new-session');
    expect(resolver.resolve().apiKey).toBe('sk-anthropic');
  });

  it('rejects models with no providers', () => {
    const reg = mkRegistry();
    expect(() =>
      createModelResolver({ id: 'empty', providers: [] }, reg),
    ).toThrow(ModelResolveError);
  });

  it('onRotate callback fires with from/to refs', () => {
    const reg = mkRegistry();
    const rotations: Array<[string, string]> = [];
    const resolver = createModelResolver(reg.models['claude-opus-4.7']!, reg, {
      onRotate: (from, to) => rotations.push([from.providerId, to.providerId]),
    });
    resolver.reportError?.(new Error('x'), { isTransient: true });
    expect(rotations).toEqual([['anthropic_main', 'zenmux_01']]);
  });
});

describe('createTierResolver', () => {
  it('resolves a tier through to its model', () => {
    const reg = mkRegistry();
    const resolver = createTierResolver('strong', reg);
    const cfg = resolver.resolve();
    expect(cfg.apiKey).toBe('sk-anthropic');
  });

  it('rejects unconfigured tiers', () => {
    const reg = mkRegistry();
    delete reg.tiers.strong;
    expect(() => createTierResolver('strong', reg)).toThrow(/not configured/);
  });

  it('rejects dangling tier pointers', () => {
    const reg = mkRegistry();
    reg.tiers.strong = 'not-a-real-model';
    expect(() => createTierResolver('strong', reg)).toThrow(/does not exist/);
  });
});
