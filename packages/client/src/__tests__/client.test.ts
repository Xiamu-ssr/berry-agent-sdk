// ============================================================
// @berry-agent/client — A8sClient + AgentHandle tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { A8sClient, A8sRequestError } from '../a8s-client.js';

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('A8sClient', () => {
  it('sends the bearer token and parses through the schema', async () => {
    let seenAuth = '';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'sek',
      fetch: stubFetch((_url, init) => {
        seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
        return json(200, { agents: [{ agentId: 'a1', workerId: 'w1' }] });
      }),
    });
    const res = await client.listAgents();
    expect(seenAuth).toBe('Bearer sek');
    expect(res.agents[0].agentId).toBe('a1');
  });

  it('throws when no token is provided', () => {
    expect(() => new A8sClient({ a8sUrl: 'http://a8s' } as never)).toThrow(/token/i);
  });

  it('resolves a function token per request', async () => {
    let n = 0;
    const tokens: string[] = [];
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: () => `t${n++}`,
      fetch: stubFetch((_url, init) => {
        tokens.push((init?.headers as Record<string, string>)?.Authorization ?? '');
        return json(200, { agents: [] });
      }),
    });
    await client.listAgents();
    await client.listAgents();
    expect(tokens).toEqual(['Bearer t0', 'Bearer t1']);
  });

  it('throws A8sRequestError with status + path on non-2xx', async () => {
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch(() => json(404, { error: { code: 'nope', message: 'gone' } })),
    });
    await expect(client.listAgents()).rejects.toBeInstanceOf(A8sRequestError);
  });

  it('builds the paginated events query string', async () => {
    let seenUrl = '';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch((url) => {
        seenUrl = url;
        return json(200, { events: [], nextBefore: null, reachedStart: true });
      }),
    });
    await client.listSessionEvents('a1', 's1', { before: 'ev5', limit: 50 });
    expect(seenUrl).toContain('/v1/agents/a1/sessions/s1/events?');
    expect(seenUrl).toContain('before=ev5');
    expect(seenUrl).toContain('limit=50');
  });

  it('agent() returns a handle bound to the agentId', () => {
    const client = new A8sClient({ a8sUrl: 'http://a8s', token: 'x' });
    expect(client.agent('coder').agentId).toBe('coder');
  });

  it('binds the default global fetch to its realm (no "Illegal invocation")', async () => {
    // A browser's native fetch throws "Illegal invocation" if called as a
    // method on another object. The client stores fetch and calls it as
    // `this.fetchImpl(...)`; without binding the default, `this` would be the
    // A8sClient. Simulate native fetch: an UNbound function that demands its
    // receiver be the global. The fix (`globalThis.fetch.bind(globalThis)`)
    // keeps the receiver; the old `?? globalThis.fetch` would throw here.
    const original = globalThis.fetch;
    function nativeLike(this: unknown, _url: string, _init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return Promise.resolve(json(200, { agents: [] }));
    }
    (globalThis as { fetch: unknown }).fetch = nativeLike;
    try {
      const client = new A8sClient({ a8sUrl: 'http://a8s', token: 'x' });
      await expect(client.listAgents()).resolves.toEqual({ agents: [] });
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });
});

describe('A8sClient.sendToAgent (streaming turn)', () => {
  it('streams live events to onEvent and resolves with the done result', async () => {
    const sse =
      'event: event\ndata: {"type":"event","event":{"type":"text_delta","text":"hel"}}\n\n'
      + 'event: event\ndata: {"type":"event","event":{"type":"text_delta","text":"lo"}}\n\n'
      + 'event: done\ndata: {"type":"done","response":{"sessionId":"s1","result":{"ok":true}}}\n\n';
    let seenMethod = '';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch((_url, init) => {
        seenMethod = init?.method ?? '';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    });
    const events: Record<string, unknown>[] = [];
    const res = await client.sendToAgent('a1', { prompt: 'hi' }, (ev) => events.push(ev));
    expect(seenMethod).toBe('POST');
    expect(events.map((e) => e.text)).toEqual(['hel', 'lo']);
    expect(res.sessionId).toBe('s1');
    expect(res.result).toEqual({ ok: true });
  });

  it('throws when the turn stream emits an error frame', async () => {
    const sse = 'event: error\ndata: {"type":"error","message":"boom"}\n\n';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    });
    await expect(client.sendToAgent('a1', { prompt: 'hi' })).rejects.toThrow(/boom/);
  });

  it('throws when the stream ends without a done frame', async () => {
    const sse = 'event: event\ndata: {"type":"event","event":{"type":"text_delta","text":"x"}}\n\n';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    });
    await expect(client.sendToAgent('a1', { prompt: 'hi' })).rejects.toThrow(/without a result/);
  });
});

describe('AgentHandle.subscribe (SSE)', () => {
  it('parses id/event/data frames and yields events, skipping keepalives', async () => {
    const sse =
      ': keepalive\n\n'
      + 'id: e1\nevent: turn_start\ndata: {"x":1}\n\n'
      + 'id: e2\nevent: text\ndata: {"y":2}\n\n';
    const client = new A8sClient({
      a8sUrl: 'http://a8s',
      token: 'x',
      fetch: stubFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    });
    const got: Array<{ id: string; type: string; data: unknown }> = [];
    for await (const ev of client.agent('a1').subscribe({ sessionId: 's1' })) {
      got.push({ id: ev.id, type: ev.type, data: ev.data });
    }
    expect(got).toEqual([
      { id: 'e1', type: 'turn_start', data: { x: 1 } },
      { id: 'e2', type: 'text', data: { y: 2 } },
    ]);
  });
});
