// ============================================================
// @berry-agent/worker-daemon — builtin-hands tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { parseBuiltinHands, selectBuiltinHands, builtinHandsToIds } from '../builtin-hands.js';

describe('parseBuiltinHands', () => {
  it('absent label → both built-in hands on (historical default)', () => {
    expect(parseBuiltinHands(undefined)).toEqual({ workspace: true, web: true });
  });

  it('comma list enables exactly the listed hands', () => {
    expect(parseBuiltinHands('workspace')).toEqual({ workspace: true, web: false });
    expect(parseBuiltinHands('web')).toEqual({ workspace: false, web: true });
    expect(parseBuiltinHands('workspace,web')).toEqual({ workspace: true, web: true });
  });

  it('empty string → no built-in hands (a pure-API / pure-collaboration agent)', () => {
    expect(parseBuiltinHands('')).toEqual({ workspace: false, web: false });
  });

  it('tolerates whitespace and ignores unknown ids (e.g. machine hands)', () => {
    expect(parseBuiltinHands(' workspace , machines ')).toEqual({ workspace: true, web: false });
  });
});

describe('selectBuiltinHands (the disk-form selector)', () => {
  it('undefined → both on (agents predating persisted selection)', () => {
    expect(selectBuiltinHands(undefined)).toEqual({ workspace: true, web: true });
  });

  it('explicit list enables exactly those ids', () => {
    expect(selectBuiltinHands(['workspace'])).toEqual({ workspace: true, web: false });
    expect(selectBuiltinHands([])).toEqual({ workspace: false, web: false });
  });
});

describe('agent.json round-trip (single source of truth)', () => {
  it('builtinHandsToIds ∘ selectBuiltinHands is stable — what we persist rehydrates identically', () => {
    for (const ids of [['workspace', 'web'], ['workspace'], ['web'], []]) {
      const sel = selectBuiltinHands(ids);
      expect(builtinHandsToIds(sel)).toEqual(ids);
    }
  });
});
