// ============================================================
// @berry-agent/a8s-admin — A8sOperatorClient unit tests
// ============================================================
// We don't spin up a real a8s here — the e2e test in a8s-server already
// covers that. These tests focus on the operator client: it sends the
// bearer admin token, parses the operator schemas, and surfaces HTTP
// errors. (Cluster ops moved from a hardcoded Hand to the berry-a8s-ops
// CLI — see 新-2 / ops-cli.ts — so there is no admin-Hand to test here.)

import { describe, expect, it } from 'vitest';
import { A8sOperatorClient } from '../operator-client.js';

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('A8sOperatorClient', () => {
  it('sends bearer admin token + parses cluster report', async () => {
    let seenAuth = '';
    const fetchImpl = stubFetch((_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.Authorization ?? headers.authorization ?? '';
      return jsonResponse(200, {
        workerCount: { total: 2, active: 1, draining: 1, evicted: 0 },
        capacity: { total: 8, used: 3, available: 5 },
        agentCount: 3,
        uptimeSeconds: 42,
      });
    });
    const client = new A8sOperatorClient({
      a8sUrl: 'http://test',
      token: 'top-secret',
      fetch: fetchImpl,
    });
    const report = await client.clusterReport();
    expect(seenAuth).toBe('Bearer top-secret');
    expect(report.workerCount.total).toBe(2);
    expect(report.capacity.available).toBe(5);
  });

  it('throws with HTTP context on non-2xx', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'no token' } }));
    const client = new A8sOperatorClient({
      a8sUrl: 'http://test',
      token: 'bad',
      fetch: fetchImpl,
    });
    await expect(client.clusterReport()).rejects.toThrow(/HTTP 401/);
  });

  it('drainWorker POSTs with empty json body', async () => {
    let seenMethod = '';
    let seenBody: unknown = null;
    const fetchImpl = stubFetch((_url, init) => {
      seenMethod = init?.method ?? '';
      seenBody = init?.body;
      return jsonResponse(200, { ok: true });
    });
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', token: 'x', fetch: fetchImpl });
    await client.drainWorker('worker-1');
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('{}');
  });
});
