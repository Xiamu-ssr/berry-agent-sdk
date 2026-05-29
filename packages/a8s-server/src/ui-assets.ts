// ============================================================
// @berry-agent/a8s-server — Built-in operator UI
// ============================================================
//
// The UI is a Vite + React + Tailwind app built into dist/ui by the
// `ui/` package. At runtime, this module reads the built artifacts off
// disk and serves them through the UI routes. There is no build step
// at server startup — the build runs once at SDK build time and the
// outputs ship inside the @berry-agent/a8s-server package.
//
// We resolve dist/ui relative to this file (works whether installed
// via npm or run from a checkout) and lazy-load on first request.

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/ui sits alongside the compiled server JS once the UI build runs.
// Fallback for the (rare) dev case where the UI hasn't been built:
// serve a tiny inline page explaining how to build it.
const UI_DIR = resolve(HERE, './ui');

const CT_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface UiAsset {
  body: Buffer;
  contentType: string;
  /** Cache header value — index.html is no-store, assets are immutable (hashed names). */
  cacheControl: string;
}

const FALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>berry-a8s</title></head>
<body style="font-family:sans-serif;padding:40px;max-width:680px;margin:auto;">
<h1>🍓 berry-a8s</h1>
<p>The UI assets are missing — this build doesn't include the operator UI.</p>
<p>To build the UI:</p>
<pre style="background:#f3f4f6;padding:12px;border-radius:6px;">cd packages/a8s-server/ui
npm install
npm run build</pre>
<p>Then restart a8s. The API is fully usable without the UI:</p>
<ul>
  <li><code>GET /v1/health</code></li>
  <li><code>GET /v1/operator/cluster</code> (admin token)</li>
  <li><code>GET /metrics</code></li>
</ul>
</body></html>`;

/**
 * Look up a UI asset by request path. `requestPath` is the URL pathname
 * after the `/ui` prefix; '/' maps to index.html.
 *
 * Returns `null` when the file doesn't exist; the caller writes 404.
 * Throws on filesystem errors. Includes path-traversal protection.
 */
export async function loadUiAsset(requestPath: string): Promise<UiAsset | null> {
  // Normalise + reject any attempt to escape UI_DIR.
  let rel = requestPath.replace(/^\/+/, '');
  if (rel === '' || rel === 'index.html') rel = 'index.html';
  const fullPath = normalize(join(UI_DIR, rel));
  if (!fullPath.startsWith(UI_DIR)) return null;

  try {
    const st = await stat(fullPath);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  const body = await readFile(fullPath);
  const ext = rel.slice(rel.lastIndexOf('.'));
  return {
    body,
    contentType: CT_MAP[ext] ?? 'application/octet-stream',
    cacheControl: rel === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  };
}

/** Fallback page when the built UI is missing on disk. */
export function fallbackHtml(): UiAsset {
  return {
    body: Buffer.from(FALLBACK_HTML, 'utf-8'),
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-store',
  };
}
