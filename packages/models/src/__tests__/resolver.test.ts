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
      // One dual-endpoint channel: serves Claude over anthropic, others over openai.
      zenmux_01: {
        id: 'zenmux_01',
        presetId: 'zenmux',
        apiKey: 'sk-zen',
      },
      // OpenAI-only preset: cannot serve a Claude model (no anthropic endpoint).
      openai_main: {
        id: 'openai_main',
        presetId: 'openai',
        apiKey: 'sk-openai',
      },
      corp_proxy: {
        id: 'corp_proxy',
        presetId: RAW_PRESET_ID,
        endpoints: { openai: 'https://corp.internal/v1' },
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
  it('uses the anthropic endpoint for a Claude model on a preset provider', () => {
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

  it('routes a Claude model on a dual-endpoint channel to the anthropic endpoint (cache regression guard)', () => {
    // The cache-regression root cause: a Claude model must NOT route through the
    // openai endpoint of a dual-protocol channel, or cache_control is bypassed.
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'zenmux_01', remoteModelId: 'anthropic/claude-opus-4.7' },
      reg.providers.zenmux_01!,
      'claude-opus-4.7',
    );
    expect(cfg.type).toBe('anthropic');
    expect(cfg.model).toBe('anthropic/claude-opus-4.7');
    expect(cfg.baseUrl).toBe('https://zenmux.ai/api/anthropic');
  });

  it('routes a non-Claude model on a dual-endpoint channel to the openai endpoint', () => {
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'zenmux_01', remoteModelId: 'google/gemini-3.1-pro-preview' },
      reg.providers.zenmux_01!,
      'gemini-pro',
    );
    expect(cfg.type).toBe('openai');
    expect(cfg.model).toBe('google/gemini-3.1-pro-preview');
    expect(cfg.baseUrl).toBe('https://zenmux.ai/api/v1');
  });

  it('throws when a Claude model lands on an openai-only provider', () => {
    const reg = mkRegistry();
    expect(() =>
      buildProviderConfig(
        { providerId: 'openai_main' },
        reg.providers.openai_main!,
        'claude-opus-4.7',
      ),
    ).toThrow(/no anthropic endpoint/);
  });

  it('uses endpoints for raw providers', () => {
    const reg = mkRegistry();
    const cfg = buildProviderConfig(
      { providerId: 'corp_proxy', remoteModelId: 'gpt-5' },
      reg.providers.corp_proxy!,
      'single-provider',
    );
    expect(cfg.baseUrl).toBe('https://corp.internal/v1');
    expect(cfg.type).toBe('openai');
  });

  it('throws when raw provider missing endpoint for the model family', () => {
    expect(() =>
      buildProviderConfig(
        { providerId: 'bad' },
        { id: 'bad', presetId: RAW_PRESET_ID, apiKey: 'x', endpoints: { anthropic: 'https://x' } },
        'gpt-5',
      ),
    ).toThrow(/no openai endpoint/);
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
    resolver.resetForSession?.();
    expect(resolver.resolve().apiKey).toBe('sk-anthropic');
  });

  it('rejects models with no providers', () => {
    const reg = mkRegistry();
    expect(() =>
      createModelResolver({ id: 'empty', providers: [] }, reg),
    ).toThrow(ModelResolveError);
  });

  it('does not advance pointer for single-provider models', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['single-provider']!, reg);
    // Even after reporting a transient error, pointer should not advance
    // because there is no fallback provider to rotate to.
    resolver.reportError?.(new Error('timeout'), { isTransient: true, statusCode: 503 });
    // Should still resolve to the same provider (not throw "All providers failed")
    const cfg = resolver.resolve();
    expect(cfg.apiKey).toBe('sk-corp');
    // Still not exhausted after multiple errors
    resolver.reportError?.(new Error('429'), { isTransient: true, statusCode: 429 });
    const cfg2 = resolver.resolve();
    expect(cfg2.apiKey).toBe('sk-corp');
    // resetForSession still works on single-provider
    resolver.resetForSession?.();
    const cfg3 = resolver.resolve();
    expect(cfg3.apiKey).toBe('sk-corp');
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

  it('resolves an operator-defined tier name (e.g. cheap), not just the legacy enum', () => {
    // Regression: parse.ts used to gate tier:X against a hardcoded
    // ['strong','balanced','fast'] list, so a `cheap` tier the template/UI
    // let operators configure threw at parse time. Tiers are template data —
    // any configured tier must resolve through to its model.
    const reg = mkRegistry();
    reg.tiers.cheap = 'single-provider';
    const resolver = createTierResolver('cheap', reg);
    expect(resolver.resolve().apiKey).toBe('sk-corp');
  });
});
