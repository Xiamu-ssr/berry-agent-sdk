// ============================================================
// machine-connector daemon — exec + auth
// ============================================================

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  MACHINE_PATHS,
  WORKER_AUTH_HEADER,
  workerAuthHeader,
  machineExecReplySchema,
  machineMcpInvokeReplySchema,
  machineReloadReplySchema,
} from '@berry-agent/cluster-protocol';
import { MachineConnectorDaemon } from '../daemon.js';
import type { MachineMcpHost } from '../mcp-host.js';

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

describe('MachineConnectorDaemon', () => {
  let daemon: MachineConnectorDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
  });

  it('runs a command on the local host via /exec, gated by the machine token', async () => {
    const port = await pickPort();
    daemon = new MachineConnectorDaemon({ machineId: 'm-test', port, bindHost: '127.0.0.1' });
    daemon.setAuthToken('machine-secret');
    const info = await daemon.start();

    // ---- health is unauthenticated ----
    const health = await fetch(`${info.callbackUrl}${MACHINE_PATHS.health}`);
    expect(health.ok).toBe(true);

    // ---- /exec without token → 401 ----
    const noAuth = await fetch(`${info.callbackUrl}${MACHINE_PATHS.exec}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi', cwd: process.cwd(), env: {} }),
    });
    expect(noAuth.status).toBe(401);

    // ---- /exec with token runs the command ----
    const ok = await fetch(`${info.callbackUrl}${MACHINE_PATHS.exec}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WORKER_AUTH_HEADER]: workerAuthHeader('machine-secret'),
      },
      body: JSON.stringify({
        command: 'echo berry-machine-ok',
        cwd: process.cwd(),
        env: {},
      }),
    });
    expect(ok.status).toBe(200);
    const reply = machineExecReplySchema.parse(await ok.json());
    expect(reply.isError).toBe(false);
    expect(reply.output).toContain('berry-machine-ok');
  });

  it('dispatches /mcp/invoke to the MCP host (M6)', async () => {
    const port = await pickPort();
    const calls: Array<{ server: string; name: string; input: Record<string, unknown> }> = [];
    // Minimal stub standing in for MachineMcpHost — only invoke() is used.
    const mcpHost = {
      invoke: async (server: string, name: string, input: Record<string, unknown>) => {
        calls.push({ server, name, input });
        return { content: `ran ${server}/${name}`, isError: false };
      },
    } as unknown as MachineMcpHost;
    daemon = new MachineConnectorDaemon({ machineId: 'm-mcp', port, bindHost: '127.0.0.1', mcpHost });
    daemon.setAuthToken('s');
    const info = await daemon.start();

    const resp = await fetch(`${info.callbackUrl}${MACHINE_PATHS.mcpInvoke}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKER_AUTH_HEADER]: workerAuthHeader('s') },
      body: JSON.stringify({ server: 'playwright', name: 'browser_navigate', input: { url: 'x' } }),
    });
    expect(resp.status).toBe(200);
    const reply = machineMcpInvokeReplySchema.parse(await resp.json());
    expect(reply.content).toBe('ran playwright/browser_navigate');
    expect(calls).toEqual([{ server: 'playwright', name: 'browser_navigate', input: { url: 'x' } }]);
  });

  it('returns isError when /mcp/invoke is called without an MCP host', async () => {
    const port = await pickPort();
    daemon = new MachineConnectorDaemon({ machineId: 'm-nomcp', port, bindHost: '127.0.0.1' });
    daemon.setAuthToken('s');
    const info = await daemon.start();
    const resp = await fetch(`${info.callbackUrl}${MACHINE_PATHS.mcpInvoke}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKER_AUTH_HEADER]: workerAuthHeader('s') },
      body: JSON.stringify({ server: 'x', name: 'y', input: {} }),
    });
    expect(resp.status).toBe(200);
    const reply = machineMcpInvokeReplySchema.parse(await resp.json());
    expect(reply.isError).toBe(true);
    expect(reply.content).toMatch(/no MCP host/);
  });

  it('rescans MCP via /reload and reports the fresh capability + fires onReload (B3)', async () => {
    const port = await pickPort();
    let reloads = 0;
    const reloaded: string[][] = [];
    // Stub host: reload() returns the new server id list; manifest() the tools.
    const mcpHost = {
      reload: async () => { reloads++; return ['fs']; },
      manifest: () => ({ tools: [{ server: 'fs', name: 'read_file' }] }),
    } as unknown as MachineMcpHost;
    daemon = new MachineConnectorDaemon({
      machineId: 'm-reload',
      port,
      bindHost: '127.0.0.1',
      mcpHost,
      onReload: (servers) => { reloaded.push(servers); },
    });
    daemon.setAuthToken('s');
    const info = await daemon.start();

    const resp = await fetch(`${info.callbackUrl}${MACHINE_PATHS.reload}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKER_AUTH_HEADER]: workerAuthHeader('s') },
    });
    expect(resp.status).toBe(200);
    const reply = machineReloadReplySchema.parse(await resp.json());
    expect(reply.mcpServers).toEqual(['fs']);
    expect(reply.mcpManifest.tools.map((t) => t.name)).toEqual(['read_file']);
    expect(reloads).toBe(1);
    expect(reloaded).toEqual([['fs']]); // onReload fired with the fresh server list
  });

  it('reload with no MCP host returns empty capability', async () => {
    const port = await pickPort();
    daemon = new MachineConnectorDaemon({ machineId: 'm-noreload', port, bindHost: '127.0.0.1' });
    daemon.setAuthToken('s');
    const info = await daemon.start();
    const resp = await fetch(`${info.callbackUrl}${MACHINE_PATHS.reload}`, {
      method: 'POST',
      headers: { [WORKER_AUTH_HEADER]: workerAuthHeader('s') },
    });
    expect(resp.status).toBe(200);
    const reply = machineReloadReplySchema.parse(await resp.json());
    expect(reply.mcpServers).toEqual([]);
    expect(reply.mcpManifest.tools).toEqual([]);
  });
});
