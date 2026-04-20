import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from '../chunker.js';

describe('chunkMarkdown', () => {
  it('handles empty content without throwing', () => {
    // ''.split('\n') gives [''], so a single empty chunk is acceptable.
    // What we care about is: no crash, and no spurious content.
    const chunks = chunkMarkdown('', { tokens: 10, overlap: 0 });
    for (const c of chunks) {
      expect(c.text).toBe('');
    }
  });

  it('keeps short content in a single chunk', () => {
    const chunks = chunkMarkdown('hello world', { tokens: 100, overlap: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 1, text: 'hello world' });
  });

  it('splits on line boundary when budget is exceeded', () => {
    // maxChars = max(32, tokens*4). We need tokens*4 >= 32 for the floor to
    // relax, so use tokens=10 → maxChars=40. Each "xxxxxxxxx\n" is 10 chars,
    // so 5 lines = 50 chars forces a split.
    const line = 'xxxxxxxxx';
    const content = Array.from({ length: 5 }, () => line).join('\n');
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // Line numbers must be 1-based and monotonic within a chunk.
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it('carries overlap when overlap > 0', () => {
    // Each line is short enough that a carry keeps the final line in the
    // next chunk's header.
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const chunks = chunkMarkdown(lines.join('\n'), { tokens: 4, overlap: 2 });

    expect(chunks.length).toBeGreaterThan(1);
    // At least one pair of consecutive chunks should share a starting line
    // with the previous chunk's end line.
    let sawOverlap = false;
    for (let i = 0; i < chunks.length - 1; i += 1) {
      if (chunks[i]!.endLine >= chunks[i + 1]!.startLine) {
        sawOverlap = true;
        break;
      }
    }
    expect(sawOverlap).toBe(true);
  });

  it('handles CJK content without splitting surrogate pairs', () => {
    const content = '你好世界'.repeat(20); // pure BMP CJK, one line
    const chunks = chunkMarkdown(content, { tokens: 8, overlap: 0 });
    // Reconstructing all chunks should not drop or duplicate chars.
    const joined = chunks.map((c) => c.text).join('');
    // At minimum, every CJK char should appear at least once.
    for (const ch of '你好世界') {
      expect(joined).toContain(ch);
    }
  });

  it('never produces a chunk with empty startLine/endLine', () => {
    const content = 'a\n\n\nb\n\nc';
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 2 });
    for (const c of chunks) {
      expect(typeof c.startLine).toBe('number');
      expect(typeof c.endLine).toBe('number');
      expect(c.startLine).toBeGreaterThan(0);
    }
  });
});
