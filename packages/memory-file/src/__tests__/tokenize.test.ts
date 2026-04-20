import { describe, it, expect } from 'vitest';
import { tokenize, jaccardSimilarity } from '../tokenize.js';

describe('tokenize', () => {
  it('lowercases ASCII words', () => {
    const t = tokenize('Hello World FooBar');
    expect(t.has('hello')).toBe(true);
    expect(t.has('world')).toBe(true);
    expect(t.has('foobar')).toBe(true);
  });

  it('splits on non-word chars', () => {
    const t = tokenize('foo-bar, baz.qux');
    expect(t.has('foo')).toBe(true);
    expect(t.has('bar')).toBe(true);
    expect(t.has('baz')).toBe(true);
    expect(t.has('qux')).toBe(true);
  });

  it('produces CJK unigrams and bigrams', () => {
    const t = tokenize('你好世界');
    // unigrams
    expect(t.has('你')).toBe(true);
    expect(t.has('好')).toBe(true);
    expect(t.has('世')).toBe(true);
    expect(t.has('界')).toBe(true);
    // bigrams
    expect(t.has('你好')).toBe(true);
    expect(t.has('好世')).toBe(true);
    expect(t.has('世界')).toBe(true);
  });

  it('does not bridge CJK bigrams across non-CJK gaps', () => {
    const t = tokenize('你好 world 世界');
    // 你+好 adjacent → bigram
    expect(t.has('你好')).toBe(true);
    // 好 and 世 are not adjacent (there's ' world ' between them)
    expect(t.has('好世')).toBe(false);
  });

  it('mixes ASCII and CJK tokens in one set', () => {
    const t = tokenize('Agent 设计 harness');
    expect(t.has('agent')).toBe(true);
    expect(t.has('harness')).toBe(true);
    expect(t.has('设')).toBe(true);
    expect(t.has('计')).toBe(true);
    expect(t.has('设计')).toBe(true);
  });
});

describe('jaccardSimilarity', () => {
  it('is 1 for identical sets', () => {
    const a = tokenize('berry agent sdk');
    const b = tokenize('berry agent sdk');
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('is 0 for disjoint non-empty sets', () => {
    const a = tokenize('apple banana');
    const b = tokenize('carrot donut');
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('is 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it('is 0 when one side is empty and the other is not', () => {
    expect(jaccardSimilarity(new Set(), tokenize('x'))).toBe(0);
    expect(jaccardSimilarity(tokenize('x'), new Set())).toBe(0);
  });

  it('gives intuitive partial overlap', () => {
    const a = tokenize('berry agent sdk');
    const b = tokenize('berry harness sdk');
    const sim = jaccardSimilarity(a, b);
    // Intersection: {berry, sdk}; union: {berry, agent, sdk, harness}.
    expect(sim).toBeCloseTo(2 / 4);
  });
});
