import { createAvatar } from '@dicebear/core';
import { pixelArt } from '@dicebear/collection';

export interface PixelAvatarOptions {
  /**
   * Optional namespace for avoiding accidental identity collisions between
   * product domains. Examples: "agent", "team", "project", "user".
   */
  namespace?: string;
  /**
   * DiceBear pixel-art size. SVG stays vector, but this controls intrinsic
   * dimensions and data-uri rendering.
   */
  size?: number;
  /**
   * Rotate to the female pixel-art variant. Defaults to deterministic auto.
   */
  flip?: boolean;
}

export interface PixelAvatar {
  provider: 'dicebear';
  style: 'pixel-art';
  seed: string;
  description: string;
  svg: string;
  dataUri: string;
}

const DEFAULT_NAMESPACE = 'berry';
const DEFAULT_SIZE = 96;

/**
 * Create a deterministic pixel avatar from arbitrary text.
 *
 * This helper intentionally has no Agent dependency. Products can feed it an
 * agent role, team name, project path, or any other short identity phrase. The
 * phrase is hashed into a stable DiceBear seed; no network request is made.
 */
export function createPixelAvatarFromText(description: string, options: PixelAvatarOptions = {}): PixelAvatar {
  const normalized = normalizeDescription(description);
  const namespace = normalizeNamespace(options.namespace);
  const seed = `${namespace}:${stableHash(`${namespace}\n${normalized}`)}`;
  const flip = options.flip ?? (stableHash(`${seed}:flip`).charCodeAt(0) % 2 === 0);
  const size = sanitizeSize(options.size);

  const avatar = createAvatar(pixelArt, {
    seed,
    size,
    flip,
    radius: 0,
    backgroundType: ['solid'],
    backgroundColor: [pickBackground(seed)],
  });
  const svg = avatar.toString();

  return {
    provider: 'dicebear',
    style: 'pixel-art',
    seed,
    description: normalized,
    svg,
    dataUri: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
  };
}

export const createAvatarFromText = createPixelAvatarFromText;

function normalizeDescription(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || 'berry visual identity';
}

function normalizeNamespace(value?: string): string {
  return (value ?? DEFAULT_NAMESPACE)
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9:_-]/g, '')
    .toLowerCase()
    || DEFAULT_NAMESPACE;
}

function sanitizeSize(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIZE;
  return Math.max(24, Math.min(256, Math.round(value ?? DEFAULT_SIZE)));
}

function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)).padStart(14, '0');
}

function pickBackground(seed: string): string {
  const palette = [
    '0f172a',
    '10231c',
    '201a10',
    '1b1830',
    '111827',
    '082f49',
    '2a151b',
    '13251f',
  ];
  const idx = stableHash(`${seed}:bg`).charCodeAt(0) % palette.length;
  return palette[idx] ?? palette[0];
}
