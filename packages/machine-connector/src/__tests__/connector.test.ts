// ============================================================
// startMachineConnector — embeddable orchestration
// ============================================================
// Proves the one-call wiring a GUI client relies on: start the daemon,
// register with a8s, plumb the returned machine token into the daemon, and
// withdraw on stop(). A stub a8s HTTP server stands in for the control plane.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  A8S_PATHS,
  MACHINE_PATHS,
  WORKER_AUTH_HEADER,
  workerAuthHeader,
  machineExecReplySchema,
} from '@berry-agent/cluster-protocol';
import { startMachineConnector, type RunningMachineConnector } from '../connector.js';

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

interface StubA8s {
  url: string;
  registers: number;
  withdrawals: number;
  close(): Promise<void>;
}

/** A minimal a8s that accepts register/heartbeat/withdraw and hands out a token. */
async function startStubA8s(machineToken: string): Promise<StubA8s> {
  const state = { registers: 0, withdrawals: 0 };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === A8S_PATHS.machinesRegister) {
      state.registers++;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ machineId: 'm-embed', heartbeatTtlMs: 30_000, machineToken }));
      return;
    }
    if (req.method === 'POST' && url.endsWith('/withdraw')) {
      state.withdrawals++;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && url.endsWith('/heartbeat')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const port = await pickPort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    get registers() { return state.registers; },
    get withdrawals() { return state.withdrawals; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('startMachineConnector', () => {
  let connector: RunningMachineConnector | null = null;
  let a8s: StubA8s | null = null;

  afterEach(async () => {
    await connector?.stop();
    connector = null;
    await a8s?.close();
    a8s = null;
  });

  it('starts the daemon, registers, and plumbs the machine token through to /exec', async () => {
    a8s = await startStubA8s('token-from-a8s');
    const port = await pickPort();
    connector = await startMachineConnector({
      a8sUrl: a8s.url,
      machineId: 'm-embed',
      port,
      bindHost: '127.0.0.1',
      mcpConfigPath: null, // disable .mcp.json discovery so the test is hermetic
    });

    expect(a8s.registers).toBe(1);
    expect(connector.callbackUrl).toBe(`http://127.0.0.1:${port}`);
    expect(connector.mcp).toBeUndefined();

    // The daemon should reject the token a8s never issued...
    const wrong = await fetch(`${connector.callbackUrl}${MACHINE_PATHS.exec}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKER_AUTH_HEADER]: workerAuthHeader('nope') },
      body: JSON.stringify({ command: 'echo x', cwd: process.cwd(), env: {} }),
    });
    expect(wrong.status).toBe(401);

    // ...and accept the one it received at registration.
    const ok = await fetch(`${connector.callbackUrl}${MACHINE_PATHS.exec}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WORKER_AUTH_HEADER]: workerAuthHeader('token-from-a8s'),
      },
      body: JSON.stringify({ command: 'echo embed-ok', cwd: process.cwd(), env: {} }),
    });
    expect(ok.status).toBe(200);
    const reply = machineExecReplySchema.parse(await ok.json());
    expect(reply.output).toContain('embed-ok');
  });

  it('withdraws from a8s on stop()', async () => {
    a8s = await startStubA8s('t');
    const port = await pickPort();
    connector = await startMachineConnector({
      a8sUrl: a8s.url,
      machineId: 'm-embed',
      port,
      bindHost: '127.0.0.1',
      mcpConfigPath: null,
    });
    await connector.stop();
    connector = null; // already stopped; avoid double-stop in afterEach
    expect(a8s.withdrawals).toBe(1);

    // Port released — a fresh listener can bind it.
    await expect(new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    })).resolves.toBeUndefined();
  });

  it('tears down the daemon when registration fails', async () => {
    // No stub a8s — point at a dead port so register() throws.
    const deadPort = await pickPort();
    const port = await pickPort();
    await expect(startMachineConnector({
      a8sUrl: `http://127.0.0.1:${deadPort}`,
      machineId: 'm-embed',
      port,
      bindHost: '127.0.0.1',
      mcpConfigPath: null,
    })).rejects.toThrow();

    // The daemon must not have been left bound to the port.
    await expect(new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    })).resolves.toBeUndefined();
  });
});
