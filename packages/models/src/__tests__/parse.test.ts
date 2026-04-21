import { describe, it, expect } from 'vitest';
import { parseModelRef, formatRawRef } from '../parse.js';

describe('parseModelRef', () => {
  it('parses tier:X forms', () => {
    expect(parseModelRef('tier:strong')).toEqual({ kind: 'tier', tier: 'strong' });
    expect(parseModelRef('tier:balanced')).toEqual({ kind: 'tier', tier: 'balanced' });
    expect(parseModelRef('tier:fast')).toEqual({ kind: 'tier', tier: 'fast' });
  });

  it('rejects unknown tiers', () => {
    expect(() => parseModelRef('tier:legendary')).toThrow(/Unknown tier/);
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

  it('parses raw:JSON inline', () => {
    const spec = 'raw:' + JSON.stringify({
      type: 'anthropic',
      apiKey: 'sk-xxx',
      model: 'claude-opus-4.7',
      baseUrl: 'https://api.anthropic.com',
    });
    const parsed = parseModelRef(spec);
    expect(parsed.kind).toBe('raw');
    if (parsed.kind === 'raw') {
      expect(parsed.config.apiKey).toBe('sk-xxx');
      expect(parsed.config.baseUrl).toBe('https://api.anthropic.com');
    }
  });

  it('parses raw:base64(JSON)', () => {
    const payload = JSON.stringify({
      type: 'openai',
      apiKey: 'sk-yyy',
      model: 'gpt-5',
    });
    const b64 = Buffer.from(payload, 'utf-8').toString('base64');
    const parsed = parseModelRef(`raw:${b64}`);
    expect(parsed.kind).toBe('raw');
    if (parsed.kind === 'raw') {
      expect(parsed.config.type).toBe('openai');
      expect(parsed.config.apiKey).toBe('sk-yyy');
    }
  });

  it('rejects malformed raw payloads', () => {
    expect(() => parseModelRef('raw:{not json')).toThrow(/not valid JSON/);
    expect(() => parseModelRef('raw:{"type":"invalid"}')).toThrow(/invalid type/);
    expect(() => parseModelRef('raw:{"type":"anthropic"}')).toThrow(/missing apiKey/);
  });

  it('rejects empty input', () => {
    expect(() => parseModelRef('')).toThrow(/Empty model reference/);
  });

  it('round-trips via formatRawRef', () => {
    const cfg = {
      type: 'anthropic' as const,
      apiKey: 'sk-zzz',
      model: 'claude-opus-4.7',
    };
    const spec = formatRawRef(cfg);
    const parsed = parseModelRef(spec);
    expect(parsed.kind).toBe('raw');
    if (parsed.kind === 'raw') {
      expect(parsed.config).toMatchObject(cfg);
    }
  });
});
