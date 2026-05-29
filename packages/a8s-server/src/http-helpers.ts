// ============================================================
// @berry-agent/a8s-server — JSON I/O helpers
// ============================================================
//
// Tiny conveniences so handlers don't repeat the same 5 lines.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      buffer += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (!buffer) { resolve({} as T); return; }
      try { resolve(JSON.parse(buffer) as T); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function writeText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(body);
}
