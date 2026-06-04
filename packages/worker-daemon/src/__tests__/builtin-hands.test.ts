// ============================================================
// @berry-agent/worker-daemon — builtin-hands tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { parseBuiltinHands } from '../builtin-hands.js';

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
