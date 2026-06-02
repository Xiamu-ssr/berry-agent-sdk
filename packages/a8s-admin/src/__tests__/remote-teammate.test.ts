// ============================================================
// @berry-agent/a8s-admin — remote teammate runtime tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { A8sOperatorClient } from '../operator-client.js';
import { createRemoteTeammateRuntimeFactory } from '../remote-teammate.js';

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An SSE turn-stream response: optional live frames + a terminal done frame. */
function sseResponse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map((f) => `event: ${f.type as string}\ndata: ${JSON.stringify(f)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('createRemoteTeammateRuntimeFactory', () => {
  it('factory calls a8s.createAgent and returns a runtime that proxies send()', async () => {
    const seen: Array<{ url: string; body?: string }> = [];
    const fetchImpl = stubFetch((url, init) => {
      seen.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/v1/agents') && init?.method === 'POST') {
        return jsonResponse(200, {
          agentId: 'reviewer',
          workerId: 'w-1',
          leaseId: 'lease-1',
        });
      }
      if (url.endsWith('/v1/agents/reviewer/send')) {
        return sseResponse([
          {
            type: 'done',
            response: {
              sessionId: 'sess-1',
              // Opaque turn-result; we just need *something* shaped vaguely
              // like ManagedAgentTurnResult for the call to round-trip.
              result: {
                sessionId: 'sess-1',
                userMessage: { id: 'u', role: 'user', content: 'review this' },
                result: { text: 'looks good', tokens: 7 },
                assistantMessage: { id: 'a', role: 'assistant', content: 'looks good' },
                view: null,
              },
            },
          },
        ]);
      }
      return jsonResponse(404, { error: { code: 'no_route', message: url } });
    });
    const client = new A8sOperatorClient({
      a8sUrl: 'http://test',
      adminToken: 't',
      fetch: fetchImpl,
    });
    const factory = createRemoteTeammateRuntimeFactory({ client });

    const runtime = await factory({
      id: 'reviewer',
      role: 'reviews code',
      systemPrompt: 'You are a careful reviewer.',
      tier: 'strong',
      project: '/projects/demo',
      leaderId: 'coder',
    });

    // createAgent was called with the wire spec we expect.
    expect(seen[0].url).toMatch(/\/v1\/agents$/);
    const createBody = JSON.parse(seen[0].body ?? '{}') as { spec: { agentId: string; model: string; labels?: Record<string,string> } };
    expect(createBody.spec.agentId).toBe('reviewer');
    expect(createBody.spec.model).toBe('tier:strong');
    expect(createBody.spec.labels?.role).toBe('reviews code');
    expect(createBody.spec.labels?.team).toBe('true');

    // send() round-trips through /v1/agents/reviewer/send.
    const turn = await runtime.send('review this');
    expect(seen[1].url).toMatch(/\/v1\/agents\/reviewer\/send$/);
    expect((turn.result as { text: string }).text).toBe('looks good');
  });

  it('addHand throws (remote teammates can not have leader-installed hands)', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(200, { agentId: 'r2', workerId: 'w', leaseId: 'l' }));
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 't', fetch: fetchImpl });
    const factory = createRemoteTeammateRuntimeFactory({ client });
    const rt = await factory({
      id: 'r2', role: 'r', systemPrompt: 's', project: '/p', leaderId: 'l',
    });
    expect(rt.hasHand('anything')).toBe(false);
    expect(() => rt.addHand()).toThrow(/addHand is not supported/);
  });

  it('modelFor override wins over tier default', async () => {
    let createBody: { spec: { model: string } } | null = null;
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/v1/agents') && init?.method === 'POST') {
        createBody = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
        return jsonResponse(200, { agentId: 'x', workerId: 'w', leaseId: 'l' });
      }
      return jsonResponse(404, {});
    });
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 't', fetch: fetchImpl });
    const factory = createRemoteTeammateRuntimeFactory({
      client,
      modelFor: () => 'tier:fast',
    });
    await factory({ id: 'x', role: 'r', systemPrompt: 's', project: '/p', leaderId: 'l', tier: 'strong' });
    expect(createBody?.spec.model).toBe('tier:fast');
  });
});
