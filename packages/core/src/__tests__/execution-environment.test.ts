import { describe, expect, it } from 'vitest';
import {
  ExecutionEnvironmentRegistry,
  createExecutionEnvironment,
  isolationPolicyFromScope,
  workspaceBindingFromScope,
} from '../execution-environment.js';
import { AgentScope } from '../scope.js';
import type { CommandExecutor, ProcessHandle } from '../executor.js';

const executor: CommandExecutor = {
  exec: async () => ({ output: 'ok', isError: false }),
  spawn: () => ({ pid: undefined } as ProcessHandle),
};

describe('execution environment boundary', () => {
  it('derives stable workspace bindings from AgentScope', () => {
    const scope = new AgentScope('/tmp/agent-home', '/tmp/project-root');

    expect(workspaceBindingFromScope(scope)).toEqual({
      workspace: '/tmp/agent-home',
      project: '/tmp/project-root',
      cwd: '/tmp/project-root',
      readableRoots: ['/tmp/project-root', '/tmp/agent-home'],
      writableRoots: ['/tmp/project-root', '/tmp/agent-home'],
    });
  });

  it('builds an isolation policy from the same scope fact source', () => {
    const scope = new AgentScope('/tmp/agent-home');
    const policy = isolationPolicyFromScope(scope, {
      extraRead: ['/opt/tools'],
      extraWrite: ['/var/tmp'],
      denyPaths: ['/secret'],
      network: 'deny',
      allowExec: false,
    });

    expect(policy).toEqual({
      allowRead: ['/tmp/agent-home', '/opt/tools'],
      allowWrite: ['/tmp/agent-home', '/var/tmp'],
      denyPaths: ['/secret'],
      network: 'deny',
      allowExec: false,
    });
  });

  it('wraps concrete runners behind a host-provided environment', async () => {
    const environment = createExecutionEnvironment({
      id: 'worker-a',
      kind: 'container',
      displayName: 'Worker A',
      createCommandExecutor: () => executor,
    });

    expect(environment.status?.()).toEqual({
      id: 'worker-a',
      kind: 'container',
      displayName: 'Worker A',
      state: 'ready',
    });
    expect(await environment.createCommandExecutor?.(new AgentScope('/tmp/ws'))?.exec('true', { cwd: '/tmp/ws' }))
      .toEqual({ output: 'ok', isError: false });

    await environment.dispose?.();
    expect(environment.status?.().state).toBe('disposed');
  });

  it('tracks multiple execution environments and disposes them together', async () => {
    const registry = new ExecutionEnvironmentRegistry();
    registry.register(createExecutionEnvironment({ id: 'shell-a', kind: 'container' }));
    registry.register(createExecutionEnvironment({ id: 'browser-b', kind: 'remote', displayName: 'Browser B' }));

    expect(registry.statuses()).toEqual([
      { id: 'shell-a', kind: 'container', state: 'ready' },
      { id: 'browser-b', kind: 'remote', displayName: 'Browser B', state: 'ready' },
    ]);
    expect(() => registry.register(createExecutionEnvironment({ id: 'shell-a', kind: 'remote' })))
      .toThrow(/already registered/);

    await registry.disposeAll();
    expect(registry.list()).toEqual([]);
  });

  it('drops one environment with disposal and keeps the rest mounted', async () => {
    const registry = new ExecutionEnvironmentRegistry();
    let disposed = 0;
    registry.register(createExecutionEnvironment({
      id: 'worker-a',
      kind: 'container',
      dispose: () => {
        disposed += 1;
      },
    }));
    registry.register(createExecutionEnvironment({ id: 'worker-b', kind: 'remote' }));

    await expect(registry.drop('worker-a')).resolves.toBe(true);
    expect(disposed).toBe(1);
    expect(registry.get('worker-a')).toBeUndefined();
    expect(registry.get('worker-b')).toBeDefined();
    await expect(registry.drop('missing')).resolves.toBe(false);
  });

  it('replaces environments only after disposing the previous runner', async () => {
    const registry = new ExecutionEnvironmentRegistry();
    const order: string[] = [];
    registry.register(createExecutionEnvironment({
      id: 'worker',
      kind: 'container',
      dispose: () => {
        order.push('dispose-old');
      },
    }));

    await registry.replace(createExecutionEnvironment({
      id: 'worker',
      kind: 'remote',
      dispose: () => {
        order.push('dispose-new');
      },
    }));

    order.push(registry.get('worker')?.kind ?? 'missing');
    expect(order).toEqual(['dispose-old', 'remote']);
    await registry.disposeAll();
    expect(order).toEqual(['dispose-old', 'remote', 'dispose-new']);
  });

  it('clears the registry even when one environment dispose throws', async () => {
    const registry = new ExecutionEnvironmentRegistry();
    let disposed = 0;
    registry.register(createExecutionEnvironment({
      id: 'bad',
      kind: 'container',
      dispose: () => {
        throw new Error('dispose failed');
      },
    }));
    registry.register(createExecutionEnvironment({
      id: 'good',
      kind: 'remote',
      dispose: () => {
        disposed += 1;
      },
    }));

    await expect(registry.disposeAll()).rejects.toThrow(/dispose failed/);
    expect(disposed).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});
