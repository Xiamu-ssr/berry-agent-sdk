// ============================================================
// PollingExecutionEnvironment tests
// ============================================================
// Exercises the queue/source/agent loop end-to-end against an in-memory
// transport. Verifies:
//   - exec() blocks until the executor agent posts a result
//   - poll() returns null on timeout (back-pressure / quiet periods)
//   - timeoutMs surfaces as a rejection on the worker side
//   - exec error from execute() round-trips as { isError: true }
//   - spawn() throws cleanly (we explicitly don't support streaming)

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentScope } from '@berry-agent/core';
import {
  InMemoryPullingTaskQueue,
  PollingExecutorAgent,
  createPollingExecutionEnvironment,
  type PullingTaskRequest,
  type PullingTaskResult,
} from '../polling-environment.js';

function makeScope(): AgentScope {
  const root = mkdtempSync(join(tmpdir(), 'polling-test-'));
  return new AgentScope(root, root);
}

describe('PollingExecutionEnvironment', () => {
  it('worker → executor agent → worker: round-trips a command', async () => {
    const queue = new InMemoryPullingTaskQueue();
    const scope = makeScope();
    const env = createPollingExecutionEnvironment({ queue });
    const executor = env.createCommandExecutor!(scope)!;

    // Start the executor-side agent loop
    const seen: PullingTaskRequest[] = [];
    const agent = new PollingExecutorAgent({
      source: queue,
      pollTimeoutMs: 5_000,
      execute: async (task) => {
        seen.push(task);
        return {
          taskId: task.taskId,
          output: `OK: ${task.command}`,
          isError: false,
        };
      },
    });
    const loop = agent.run();

    const result = await executor.exec('echo hello', { cwd: '/work' });
    expect(result).toEqual({ output: 'OK: echo hello', isError: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe('echo hello');
    expect(seen[0].cwd).toBe('/work');

    agent.stop();
    await loop;
  });

  it('multiple concurrent execs each get their own result', async () => {
    const queue = new InMemoryPullingTaskQueue();
    const scope = makeScope();
    const env = createPollingExecutionEnvironment({ queue });
    const executor = env.createCommandExecutor!(scope)!;

    const agent = new PollingExecutorAgent({
      source: queue,
      pollTimeoutMs: 5_000,
      execute: async (task) => ({
        taskId: task.taskId,
        output: `done:${task.command}`,
        isError: false,
      }),
    });
    const loop = agent.run();

    const [a, b, c] = await Promise.all([
      executor.exec('one', { cwd: '/work' }),
      executor.exec('two', { cwd: '/work' }),
      executor.exec('three', { cwd: '/work' }),
    ]);
    expect(a.output).toBe('done:one');
    expect(b.output).toBe('done:two');
    expect(c.output).toBe('done:three');

    agent.stop();
    await loop;
  });

  it('rejects with timeout when result never comes', async () => {
    const queue = new InMemoryPullingTaskQueue();
    const scope = makeScope();
    const env = createPollingExecutionEnvironment({ queue, defaultTimeoutMs: 50 });
    const executor = env.createCommandExecutor!(scope)!;

    // No executor agent running, so the result will never come back.
    await expect(executor.exec('sleep forever', { cwd: '/work' }))
      .rejects.toThrow(/timed out/);
  });

  it('executor error surfaces as isError: true (loop survives)', async () => {
    const queue = new InMemoryPullingTaskQueue();
    const scope = makeScope();
    const env = createPollingExecutionEnvironment({ queue });
    const executor = env.createCommandExecutor!(scope)!;

    const agent = new PollingExecutorAgent({
      source: queue,
      pollTimeoutMs: 5_000,
      execute: async () => {
        throw new Error('something broke on the remote host');
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const loop = agent.run();

    const result = await executor.exec('crashing-command', { cwd: '/work' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('something broke');

    // The loop should still be alive for a second command
    const result2 = await Promise.race([
      executor.exec('second', { cwd: '/work' }).then(() => 'completed').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(result2).toBe('completed');

    agent.stop();
    await loop;
  });

  it('spawn() throws explicitly — streaming not supported by this transport', () => {
    const queue = new InMemoryPullingTaskQueue();
    const scope = makeScope();
    const env = createPollingExecutionEnvironment({ queue });
    const executor = env.createCommandExecutor!(scope)!;
    expect(() => executor.spawn('tail -f /var/log/foo', { cwd: '/work' }))
      .toThrow(/does not support spawn/);
  });

  it('poll returns null on idle timeout (quiet period back-pressure)', async () => {
    const queue = new InMemoryPullingTaskQueue();
    const start = Date.now();
    const result = await queue.poll(100);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });

  it('queue accepts result for unknown task without throwing', async () => {
    const queue = new InMemoryPullingTaskQueue();
    // Late / duplicate result: just gets dropped, no error.
    await queue.postResult({
      taskId: 'never-existed',
      output: 'late',
      isError: false,
    } satisfies PullingTaskResult);
  });
});
