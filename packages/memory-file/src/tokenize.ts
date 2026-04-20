/**
 * CJK-aware tokenizer — ported from OpenClaw's `tokenize`
 * (node_modules/openclaw/dist/manager-cQ8cHF3H.js as of 2026-04-20).
 *
 * Returns a token set suitable for Jaccard similarity. The tokenizer is
 * intentionally cheap (no language model, no stemming), which matches the
 * MMR use case — we need *relative* similarity between chunks, not a
 * linguistically perfect tokenization.
 *
 * Strategy:
 * - ASCII words: lowercase `[a-z0-9_]+`
 * - CJK:
 *   - every CJK char contributes a unigram
 *   - adjacent CJK chars contribute a bigram (OpenClaw's trick for Chinese
 *     word boundary without an actual segmenter)
 */

// Same Unicode block coverage as OpenClaw:
//   CJK Unified Ideographs (U+4E00–U+9FFF)
//   CJK Compat (U+3400–U+4DBF, U+F900–U+FAFF)
//   Hiragana/Katakana (U+3040–U+30FF)
//   Hangul (U+AC00–U+D7A3)
//   Plus extension A/B range starters — we keep a compact regex; edge cases
//   (surrogate-pair CJK extensions) aren't critical for v0.4.
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]/;

export function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const asciiMatches = lower.match(/[a-z0-9_]+/g) ?? [];

  const chars = Array.from(lower);
  const cjk: { char: string; index: number }[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (CJK_RE.test(c)) cjk.push({ char: c, index: i });
  }

  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i += 1) {
    if (cjk[i + 1]!.index === cjk[i]!.index + 1) {
      bigrams.push(cjk[i]!.char + cjk[i + 1]!.char);
    }
  }
  const unigrams = cjk.map((d) => d.char);

  return new Set<string>([...asciiMatches, ...bigrams, ...unigrams]);
}

/** Jaccard similarity between two token sets. In [0, 1]. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const t of smaller) if (larger.has(t)) intersection += 1;

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
