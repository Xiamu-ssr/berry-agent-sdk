// ============================================================
// createModelResolver / createTierResolver — getSnapshot()
// ============================================================

import { describe, it, expect } from 'vitest';
import { createModelResolver, createTierResolver } from '../resolver.js';
import { ModelResolverSnapshot } from '../resolver-snapshot.js';
import type { ModelsRegistry } from '../types.js';

function mkRegistry(): ModelsRegistry {
  return {
    providers: {
      a: { id: 'a', presetId: 'anthropic', apiKey: 'k1' },
      b: { id: 'b', presetId: 'zenmux', apiKey: 'k2' },
    },
    models: {
      'dual-model': {
        id: 'dual-model',
        providers: [{ providerId: 'a' }, { providerId: 'b' }],
      },
    },
    tiers: { strong: 'dual-model' },
  };
}

describe('ModelResolver.getSnapshot()', () => {
  it('returns a ModelResolverSnapshot with provider list and pointer=0 initially', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);

    const snap = resolver.getSnapshot();
    expect(snap).toBeInstanceOf(ModelResolverSnapshot);
    expect(snap.id).toBe('model:dual-model');
    expect(snap.modelId).toBe('dual-model');
    expect(snap.providers).toHaveLength(2);
    expect(snap.providers[0]!.providerId).toBe('a');
    expect(snap.pointer).toBe(0);
    expect(snap.exhausted).toBe(false);
    expect(snap.lastError).toBeUndefined();
    expect(typeof snap.capturedAt).toBe('number');
  });

  it('pointer advances after reportError() when failover applies', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);

    resolver.reportError!(new Error('boom'), { isTransient: true });
    const snap = resolver.getSnapshot();
    expect(snap.pointer).toBe(1);
    expect(snap.exhausted).toBe(false);
    expect(snap.lastError?.message).toBe('boom');
    expect(snap.lastError?.name).toBe('Error');
  });

  it('exhausted becomes true once all providers fail', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);

    resolver.reportError!(new Error('e1'), { isTransient: true });
    resolver.reportError!(new Error('e2'), { isTransient: true });

    const snap = resolver.getSnapshot();
    expect(snap.exhausted).toBe(true);
    expect(snap.pointer).toBe(2);
    expect(snap.lastError?.message).toBe('e2');
  });

  it('resetForSession() resets pointer and exhausted; snapshot reflects that', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);

    resolver.reportError!(new Error('x'), { isTransient: true });
    resolver.reportError!(new Error('y'), { isTransient: true });
    resolver.resetForSession!();

    const snap = resolver.getSnapshot();
    expect(snap.pointer).toBe(0);
    expect(snap.exhausted).toBe(false);
    expect(snap.lastError).toBeUndefined();
  });

  it('snapshot is frozen — subsequent state changes do not mutate a past snapshot', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);

    const before = resolver.getSnapshot();
    expect(before.pointer).toBe(0);

    resolver.reportError!(new Error('z'), { isTransient: true });
    expect(before.pointer).toBe(0); // captured value unchanged
    expect(resolver.getSnapshot().pointer).toBe(1);
  });

  it('tier resolver snapshot uses the tier:X:Y id', () => {
    const reg = mkRegistry();
    const tier = createTierResolver('strong', reg);
    const snap = tier.getSnapshot();
    expect(snap.id).toBe('tier:strong:dual-model');
    expect(snap.modelId).toBe('dual-model');
    expect(snap.pointer).toBe(0);
  });

  it('toJSON() produces plain data', () => {
    const reg = mkRegistry();
    const resolver = createModelResolver(reg.models['dual-model']!, reg);
    const snap = resolver.getSnapshot();
    const json = snap.toJSON();
    expect(json.id).toBe('model:dual-model');
    expect(json.providers).toEqual(snap.providers);
    expect(json.pointer).toBe(0);
  });
});
