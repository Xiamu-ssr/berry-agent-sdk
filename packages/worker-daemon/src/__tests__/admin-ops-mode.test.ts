// ============================================================
// @berry-agent/worker-daemon — admin-ops-mode unit tests
// ============================================================
// Verifies the 新-2 wiring: the berry-admin agent (labels.role=a8s-admin)
// gets no cluster tools, but does get (a) its home seeded with the ops
// skills and (b) the a8s credentials injected into its execution
// environment so the berry-a8s-ops CLI can authenticate.

import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentHome, AgentScope, type ExecOptions } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';
import { withAdminOpsEnv } from '../admin-ops-mode.js';
import { createCredentialInjectingProvider } from '../admin-ops-env.js';

function stubResolve(root: string): (wire: { agentId: string; workspace: string; model: string; labels?: Record<string, string> }) => WorkerAgentSpec {
  return (wire) => ({
    agentId: wire.agentId,
    workspace: join(root, wire.agentId),
    home: new AgentHome(join(root, wire.agentId)),
    model: wire.model,
    ensureDefaultMcpConfig: false,
  });
}

describe('withAdminOpsEnv', () => {
  it('leaves non-admin agents untouched (no env provider, no tools)', () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-ops-'));
    const wrapped = withAdminOpsEnv(stubResolve(root) as never, { a8sUrl: 'http://a8s', adminToken: 't' });
    const spec = wrapped({ agentId: 'plain', workspace: 'plain', model: 'tier:strong' });
    expect(spec.executionEnvironmentProvider).toBeUndefined();
    expect(spec.hostTools).toBeUndefined();
  });

  it('admin agent: seeds ops skills + injects an execution env provider, adds no tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-ops-'));
    const wrapped = withAdminOpsEnv(stubResolve(root) as never, { a8sUrl: 'http://a8s:8080', adminToken: 'sek' });
    const spec = wrapped({
      agentId: 'berry-admin', workspace: 'berry-admin', model: 'tier:strong',
      labels: { role: 'a8s-admin' },
    });

    // No cluster tools added — ops are CLI+skill now.
    expect(spec.hostTools ?? []).toHaveLength(0);

    // Home seeded with both skills.
    expect(existsSync(join(root, 'berry-admin', 'skills', 'a8s-ops', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'berry-admin', 'skills', 'install-worker', 'SKILL.md'))).toBe(true);

    // Execution env provider is injected and yields a working executor
    // (bare fallback when the base env has no sandbox executor on this
    // platform). The credential-merge behavior itself is asserted below
    // via createCredentialInjectingProvider over a probe base.
    expect(spec.executionEnvironmentProvider).toBeDefined();
    const env = await spec.executionEnvironmentProvider!.provision({} as never);
    const scope = new AgentScope(join(root, 'berry-admin'));
    const executor = env!.createCommandExecutor!(scope)!;
    expect(typeof executor.exec).toBe('function');
  });

  it('injects BERRY_A8S_* into the command env', async () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    const base = {
      provision: () => ({
        id: 'probe', kind: 'local' as const,
        createCommandExecutor: () => ({
          async exec(_cmd: string, options: ExecOptions) { seenEnv = options.env; return { output: '', isError: false }; },
          spawn() { throw new Error('not used'); },
        }),
      }),
    };
    const provider = createCredentialInjectingProvider(base, {
      BERRY_A8S_URL: 'http://a8s:8080', BERRY_A8S_ADMIN_TOKEN: 'sek',
    });
    const env = await provider.provision({} as never);
    await env!.createCommandExecutor!(new AgentScope('/tmp/ws'))!.exec('env', { cwd: '/tmp' });
    expect(seenEnv?.BERRY_A8S_URL).toBe('http://a8s:8080');
    expect(seenEnv?.BERRY_A8S_ADMIN_TOKEN).toBe('sek');
  });

  it('caller-supplied env wins over injected credentials', async () => {
    let seenEnv: Record<string, string | undefined> | undefined;
    const base = {
      provision: () => ({
        id: 'probe', kind: 'local' as const,
        createCommandExecutor: () => ({
          async exec(_cmd: string, options: ExecOptions) { seenEnv = options.env; return { output: '', isError: false }; },
          spawn() { throw new Error('not used'); },
        }),
      }),
    };
    const provider = createCredentialInjectingProvider(base, { BERRY_A8S_URL: 'http://injected', BERRY_A8S_ADMIN_TOKEN: 'sek' });
    const env = await provider.provision({} as never);
    const scope = new AgentScope('/tmp/ws');
    await env!.createCommandExecutor!(scope)!.exec('x', { cwd: '/tmp', env: { BERRY_A8S_URL: 'http://override' } });
    expect(seenEnv?.BERRY_A8S_URL).toBe('http://override');
    expect(seenEnv?.BERRY_A8S_ADMIN_TOKEN).toBe('sek');
  });
});
