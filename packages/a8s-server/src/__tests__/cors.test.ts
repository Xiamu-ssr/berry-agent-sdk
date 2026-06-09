// ============================================================
// a8s-server CORS — browser direct-connect preflight + headers
// ============================================================
// berry-claw (and other products) call a8s directly from the browser, a
// cross-origin request. Without CORS the browser blocks every call with
// "Failed to fetch". This guards the preflight + reflected-origin behavior.

import { describe, expect, it, afterEach } from 'vitest';
import { RuntimeOrchestrator, MemoryRuntimeOrchestrationStore } from '@berry-agent/runtime';
import { A8sServer } from '../server.js';

async function pickPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let running: A8sServer | null = null;
afterEach(async () => { await running?.stop(); running = null; });

async function boot(): Promise<string> {
  const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
  const server = new A8sServer({ port: await pickPort(), controlPlane: { orchestrator }, adminToken: 'tok' });
  running = server;
  const info = await server.start();
  return info.url;
}

describe('a8s-server CORS', () => {
  it('answers OPTIONS preflight with 204 and reflects the Origin', async () => {
    const url = await boot();
    const res = await fetch(`${url}/v1/agents`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3219',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3219');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    // Reflects the requested headers so the bearer token may ride along.
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('authorization');
  });

  it('sets Access-Control-Allow-Origin on a real (non-preflight) response', async () => {
    const url = await boot();
    const res = await fetch(`${url}/v1/agents`, {
      headers: { origin: 'http://localhost:3219', authorization: 'Bearer tok' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3219');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('omits CORS headers when there is no Origin (same-origin / server-to-server)', async () => {
    const url = await boot();
    const res = await fetch(`${url}/v1/agents`, { headers: { authorization: 'Bearer tok' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
