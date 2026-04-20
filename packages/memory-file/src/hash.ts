/**
 * Tiny content hash used as a stable chunk id.
 *
 * We deliberately don't import `node:crypto` — this hash needs to work the
 * same way in every environment we ever care about, and it only has to be
 * stable within a single index build. Collisions are not a security
 * concern here.
 *
 * The algorithm is a 53-bit variant of FNV-1a + cyrb53. Output is a 13-char
 * base36 string, which is short enough for tool payloads and long enough to
 * give us > 10^15 distinct ids.
 */

export function hashText(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = (h2 >>> 0).toString(36).padStart(7, '0');
  const hi = (h1 >>> 0).toString(36).padStart(7, '0');
  return (hi + lo).slice(0, 13);
}
