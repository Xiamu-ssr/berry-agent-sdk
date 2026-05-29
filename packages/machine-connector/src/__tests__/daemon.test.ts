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
} from '@berry-agent/cluster-protocol';
import { MachineConnectorDaemon } from '../daemon.js';

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
});
