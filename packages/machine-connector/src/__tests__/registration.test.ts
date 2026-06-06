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
