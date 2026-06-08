// ============================================================
// machine-connector registration — dynamic capability re-report (B3)
// ============================================================
// Proves a reloaded MCP capability reaches a8s via heartbeat, not only at
// register time — the propagation path for "a8s remotely provisions a Hand".

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { A8S_PATHS } from '@berry-agent/cluster-protocol';
import { MachineRegistrationClient } from '../registration.js';

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Captured {
  register: unknown[];
  heartbeat: unknown[];
}

/** Stub a8s that records register + heartbeat bodies. */
async function startStub(captured: Captured): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const body = buf ? JSON.parse(buf) : {};
      const url = req.url ?? '';
      if (url === A8S_PATHS.machinesRegister) {
        captured.register.push(body);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ machineId: 'm-cap', heartbeatTtlMs: 30_000, machineToken: 'tok' }));
        return;
      }
      if (url.endsWith('/heartbeat')) {
        captured.heartbeat.push(body);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, heartbeatTtlMs: 30_000 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const port = await pickPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('MachineRegistrationClient capability re-report', () => {
  let stub: { url: string; close(): Promise<void> } | null = null;
  let client: MachineRegistrationClient | null = null;

  afterEach(async () => {
    await client?.withdraw().catch(() => {});
    client = null;
    await stub?.close();
    stub = null;
  });

  it('heartbeat carries capability updated after register (the reload path)', async () => {
    const captured: Captured = { register: [], heartbeat: [] };
    stub = await startStub(captured);

    client = new MachineRegistrationClient({
      a8sUrl: stub.url,
      machineId: 'm-cap',
      callbackUrl: 'http://127.0.0.1:1',
      heartbeatTtlMs: 30_000,
      mcpServers: ['web'],
      mcpManifest: { tools: [{ server: 'web', name: 'fetch' }] },
      // Use a private accessor to drive heartbeats deterministically.
      fetch: globalThis.fetch,
    });
    await client.register();

    // Registration reported the initial capability.
    expect((captured.register[0] as { mcpServers: string[] }).mcpServers).toEqual(['web']);

    // A Hand is provisioned remotely → connector reloads → pushes new capability.
    client.updateCapability(['web', 'fs'], { tools: [{ server: 'fs', name: 'read_file' }] });

    // Drive one heartbeat directly (avoid waiting on the timer).
    await (client as unknown as { heartbeatOnce(): Promise<void> }).heartbeatOnce();

    const lastBeat = captured.heartbeat.at(-1) as { mcpServers: string[]; mcpManifest: { tools: { name: string }[] } };
    expect(lastBeat.mcpServers).toEqual(['web', 'fs']);
    expect(lastBeat.mcpManifest.tools.map((t) => t.name)).toEqual(['read_file']);
  });
});

// ============================================================
// onToken re-publish on re-register (bug: /exec 401 after a8s restart)
// ============================================================
// The daemon validates /exec against a token copy it gets via onToken. On a
// re-register (heartbeat 401/404/410 → register again), a8s issues a FRESH
// machine token. If onToken doesn't fire on re-register, the daemon keeps the
// stale token and every a8s-brokered exec 401s permanently until the connector
// process restarts. This proves onToken fires on BOTH register and re-register
// and carries the new token each time.
describe('MachineRegistrationClient onToken re-publish', () => {
  let stub: { url: string; close(): Promise<void> } | null = null;
  let client: MachineRegistrationClient | null = null;

  afterEach(async () => {
    await client?.withdraw().catch(() => {});
    client = null;
    await stub?.close();
    stub = null;
  });

  /**
   * Stub that mints a new token on each register and 401s the first heartbeat
   * once (simulating a8s losing its machine table after a restart).
   */
  async function startRotatingStub(): Promise<{ url: string; close(): Promise<void>; registerCount: number }> {
    const state = { registerCount: 0, heartbeatCount: 0 };
    const server: Server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url === A8S_PATHS.machinesRegister) {
          state.registerCount += 1;
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ machineId: 'm-rot', heartbeatTtlMs: 30_000, machineToken: `tok-${state.registerCount}` }));
          return;
        }
        if (url.endsWith('/heartbeat')) {
          state.heartbeatCount += 1;
          // First heartbeat 401s → forces a re-register (a8s lost the machine).
          if (state.heartbeatCount === 1) {
            res.statusCode = 401;
            res.end('{}');
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, heartbeatTtlMs: 30_000 }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    const port = await pickPort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      get registerCount() { return state.registerCount; },
    };
  }

  it('fires onToken on initial register and again with the fresh token after a 401 re-register', async () => {
    const rotating = await startRotatingStub();
    stub = rotating;
    const tokens: string[] = [];

    client = new MachineRegistrationClient({
      a8sUrl: rotating.url,
      machineId: 'm-rot',
      callbackUrl: 'http://127.0.0.1:1',
      heartbeatTtlMs: 30_000,
      onToken: (t) => tokens.push(t),
      fetch: globalThis.fetch,
    });

    await client.register();
    expect(tokens).toEqual(['tok-1']);
    expect(client.getToken()).toBe('tok-1');

    // Drive the heartbeat that 401s → internal re-register mints tok-2 and must
    // re-publish it so the daemon's /exec validator tracks the live token.
    await (client as unknown as { heartbeatOnce(): Promise<void> }).heartbeatOnce();

    expect(rotating.registerCount).toBe(2);
    expect(tokens).toEqual(['tok-1', 'tok-2']);
    expect(client.getToken()).toBe('tok-2');
  });
});
