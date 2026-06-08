import { describe, it, expect } from 'vitest';
import { parseModelRef } from '../parse.js';

describe('parseModelRef', () => {
  it('parses tier:X forms', () => {
    expect(parseModelRef('tier:strong')).toEqual({ kind: 'tier', tier: 'strong' });
    expect(parseModelRef('tier:balanced')).toEqual({ kind: 'tier', tier: 'balanced' });
    expect(parseModelRef('tier:fast')).toEqual({ kind: 'tier', tier: 'fast' });
  });

  it('parses operator-defined tiers syntactically (vocabulary is template data, not a fixed enum)', () => {
    // The template/UI let operators define tiers like `cheap`; parse must not
    // gate against a hardcoded list. Whether the tier is *configured* is the
    // resolver's job (it checks the registry), not the parser's.
    expect(parseModelRef('tier:cheap')).toEqual({ kind: 'tier', tier: 'cheap' });
    expect(parseModelRef('tier:legendary')).toEqual({ kind: 'tier', tier: 'legendary' });
  });

  it('rejects an empty tier name', () => {
    expect(() => parseModelRef('tier:')).toThrow(/Empty tier name/);
    expect(() => parseModelRef('tier:   ')).toThrow(/Empty tier name/);
  });

  it('parses model:X forms', () => {
    expect(parseModelRef('model:claude-opus-4.7')).toEqual({
      kind: 'model',
      modelId: 'claude-opus-4.7',
    });
  });

  it('treats bare strings as model ids', () => {
    expect(parseModelRef('kimi-k2.6')).toEqual({ kind: 'model', modelId: 'kimi-k2.6' });
    expect(parseModelRef('anthropic/claude-opus-4.7')).toEqual({
      kind: 'model',
      modelId: 'anthropic/claude-opus-4.7',
    });
  });

  it('rejects raw provider payloads in model refs', () => {
    expect(() => parseModelRef('raw:{"type":"anthropic","apiKey":"sk","model":"m"}')).toThrow(
      /raw: model references are not supported/,
    );
  });

  it('rejects empty input', () => {
    expect(() => parseModelRef('')).toThrow(/Empty model reference/);
  });

});
