// ============================================================
// Container + Remote ExecutionEnvironment tests
// ============================================================
// These tests inject mock ContainerDriver / RemoteTransport so we exercise
// the SDK wiring without actually needing docker or a remote HTTP server.

import { describe, expect, it, vi, beforeAll } from 'vitest';
import { AgentScope } from '@berry-agent/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  createContainerExecutionEnvironment,
  type ContainerDriver,
} from '../container-environment.js';
import {
  createRemoteExecutionEnvironment,
  remoteExecRequestSchema,
  type RemoteSpawnStream,
  type RemoteTransport,
} from '../remote-environment.js';

function makeScope(): AgentScope {
  const root = join(tmpdir(), `berry-env-test-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, 'workspace');
  const project = join(root, 'project');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(project, { recursive: true });
  return new AgentScope(workspace, project);
}

describe('createContainerExecutionEnvironment', () => {
  it('starts a container lazily and runs exec inside it', async () => {
    const driver: ContainerDriver = {
      start: vi.fn().mockResolvedValue('container-abc'),
      exec: vi.fn().mockResolvedValue({ output: 'hello\n', isError: false }),
      spawn: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const env = createContainerExecutionEnvironment({
      image: 'node:20',
      workspaceMount: { hostPath: '/host/workspace', containerPath: '/workspace' },
      driver,
    });

    const scope = makeScope();
    const executor = env.createCommandExecutor!(scope)!;
    expect(driver.start).not.toHaveBeenCalled();

    const result = await executor.exec('echo hello', { cwd: '/workspace' });
    expect(result.output).toContain('hello');
    expect(driver.start).toHaveBeenCalledOnce();
    expect(driver.exec).toHaveBeenCalledWith(expect.objectContaining({
      containerId: 'container-abc',
      command: 'echo hello',
      cwd: '/workspace',
    }));

    await executor.exec('echo again', { cwd: '/workspace' });
    expect(driver.start).toHaveBeenCalledOnce(); // started exactly once across two execs
  });

  it('does not stop a reused container on dispose', async () => {
    const driver: ContainerDriver = {
      start: vi.fn().mockResolvedValue('reused'),
      exec: vi.fn().mockResolvedValue({ output: '', isError: false }),
      spawn: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const env = createContainerExecutionEnvironment({
      containerId: 'existing-id',
      driver,
    });
    await env.dispose?.();
    expect(driver.stop).not.toHaveBeenCalled();
  });

  it('stops the container it started on dispose', async () => {
    const driver: ContainerDriver = {
      start: vi.fn().mockResolvedValue('owned'),
      exec: vi.fn().mockResolvedValue({ output: '', isError: false }),
      spawn: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const env = createContainerExecutionEnvironment({
      image: 'busybox',
      workspaceMount: { hostPath: '/host', containerPath: '/work' },
      driver,
    });
    const executor = env.createCommandExecutor!(makeScope())!;
    await executor.exec('true', { cwd: '/work' });

    await env.dispose?.();
    expect(driver.stop).toHaveBeenCalledWith('owned');
  });

  it('reports kind and isolation policy', () => {
    const driver: ContainerDriver = {
      start: vi.fn().mockResolvedValue('id'),
      exec: vi.fn(),
      spawn: vi.fn(),
      stop: vi.fn(),
    };
    const env = createContainerExecutionEnvironment({
      image: 'busybox',
      workspaceMount: { hostPath: '/host', containerPath: '/work' },
      driver,
    });
    expect(env.kind).toBe('container');
    const policy = env.isolationPolicy?.(makeScope());
    expect(policy?.allowExec).toBe(true);
  });

  it('errors when starting without image and without containerId', async () => {
    const driver: ContainerDriver = {
      start: vi.fn(),
      exec: vi.fn(),
      spawn: vi.fn(),
      stop: vi.fn(),
    };
    const env = createContainerExecutionEnvironment({ driver });
    const executor = env.createCommandExecutor!(makeScope())!;
    await expect(executor.exec('echo', { cwd: '/work' })).rejects.toThrow(/image is required/);
  });
});

describe('createRemoteExecutionEnvironment', () => {
  it('validates request payload and returns transport reply', async () => {
    const exec = vi.fn().mockResolvedValue({ output: 'remote-out', isError: false });
    const transport: RemoteTransport = { exec };

    const env = createRemoteExecutionEnvironment({ transport });
    const executor = env.createCommandExecutor!(makeScope())!;
    const result = await executor.exec('ls -la', { cwd: '/srv/app', env: { TOKEN: 'abc' } });

    expect(result).toEqual({ output: 'remote-out', isError: false });
    expect(exec).toHaveBeenCalledOnce();
    const captured = remoteExecRequestSchema.parse(exec.mock.calls[0][0]);
    expect(captured).toMatchObject({
      command: 'ls -la',
      cwd: '/srv/app',
      env: { TOKEN: 'abc' },
    });
  });

  it('throws when the transport rejects the reply schema', async () => {
    const transport: RemoteTransport = {
      exec: vi.fn().mockResolvedValue({ output: 123, isError: 'no' }),
    };
    const env = createRemoteExecutionEnvironment({ transport });
    const executor = env.createCommandExecutor!(makeScope())!;
    await expect(executor.exec('true', { cwd: '/srv' })).rejects.toThrow();
  });

  it('throws spawn() when the transport does not support streaming', () => {
    const transport: RemoteTransport = { exec: vi.fn() };
    const env = createRemoteExecutionEnvironment({ transport });
    const executor = env.createCommandExecutor!(makeScope())!;
    expect(() => executor.spawn('tail -f log', { cwd: '/srv' })).toThrow(/does not implement spawn/);
  });

  it('forwards spawn through transport-provided stream', () => {
    const stdoutSubs: Array<(chunk: string) => void> = [];
    const stream: RemoteSpawnStream = {
      pid: 4242,
      stdinWritable: true,
      onStdOut: (handler) => { stdoutSubs.push(handler); },
      onStdErr: () => {},
      onExit: () => {},
      onError: () => {},
      write: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
    };
    const transport: RemoteTransport = {
      exec: vi.fn(),
      spawn: vi.fn().mockReturnValue(stream),
    };
    const env = createRemoteExecutionEnvironment({ transport });
    const executor = env.createCommandExecutor!(makeScope())!;
    const handle = executor.spawn('node server.js', { cwd: '/srv' });

    let captured = '';
    handle.onStdOut((chunk) => { captured += chunk; });
    stdoutSubs[0]('chunk-1');
    expect(captured).toBe('chunk-1');
    expect(handle.pid).toBe(4242);

    handle.kill('SIGINT');
    expect(stream.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('disposes the transport on environment dispose', async () => {
    const dispose = vi.fn();
    const transport: RemoteTransport = { exec: vi.fn(), dispose };
    const env = createRemoteExecutionEnvironment({ transport });
    await env.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
