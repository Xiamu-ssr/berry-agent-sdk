/**
 * Markdown chunker — ported from OpenClaw's `chunkMarkdown`
 * (node_modules/openclaw/dist/internal-DHMTwtHq.js as of 2026-04-20).
 *
 * Design:
 * - Char-based estimator. 1 token ≈ 4 chars (same heuristic OpenClaw uses).
 * - Never splits a line in the middle unless the line alone is longer than
 *   `maxChars`, in which case it falls back to per-char slicing with UTF-16
 *   surrogate-pair awareness.
 * - Overlap is carried forward from the tail of the previous chunk until it
 *   covers `overlapChars`, so sequential chunks always share some context.
 * - Output includes 1-based line numbers referring to the original file,
 *   making citations straightforward.
 */

export interface ChunkOptions {
  /** Target chunk size in tokens (char budget = tokens * 4) */
  tokens: number;
  /** Overlap size in tokens (char budget = overlap * 4) */
  overlap: number;
}

export interface Chunk {
  startLine: number;  // 1-based, inclusive
  endLine: number;    // 1-based, inclusive
  text: string;
}

interface Entry {
  line: string;
  lineNo: number;
}

function estimateStringChars(s: string): number {
  // OpenClaw uses a simple .length which works because JS strings are UTF-16
  // code units. Byte-accuracy is not required for chunk sizing.
  return s.length;
}

export function chunkMarkdown(content: string, options: ChunkOptions): Chunk[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, options.tokens * 4);
  const overlapChars = Math.max(0, options.overlap * 4);

  const chunks: Chunk[] = [];
  let current: Entry[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const text = current.map((e) => e.line).join('\n');
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Entry[] = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;
      acc += estimateStringChars(entry.line) + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce(
      (sum, entry) => sum + estimateStringChars(entry.line) + 1,
      0,
    );
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const segments: string[] = [];

    if (line.length === 0) {
      segments.push('');
    } else {
      // Coarse: slice by maxChars.
      for (let start = 0; start < line.length; start += maxChars) {
        const coarse = line.slice(start, start + maxChars);
        if (estimateStringChars(coarse) > maxChars) {
          // Fine: slice per-char, keeping UTF-16 surrogate pairs together.
          const fineStep = Math.max(1, options.tokens);
          for (let j = 0; j < coarse.length; ) {
            let end = Math.min(j + fineStep, coarse.length);
            if (end < coarse.length) {
              const code = coarse.charCodeAt(end - 1);
              if (code >= 0xd800 && code <= 0xdbff) end += 1; // high surrogate
            }
            segments.push(coarse.slice(j, end));
            j = end;
          }
        } else {
          segments.push(coarse);
        }
      }
    }

    for (const segment of segments) {
      const lineSize = estimateStringChars(segment) + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}
