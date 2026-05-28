import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentRuntime } from '@berry-agent/core';
import { ManagedRuntimeRegistry } from '../registry.js';

function runtime(id: string) {
  const dispose = vi.fn();
  return {
    runtime: { dispose } as unknown as ManagedAgentRuntime,
    workspace: `/tmp/${id}`,
    dispose,
  };
}

describe('ManagedRuntimeRegistry', () => {
  it('mounts one managed runtime per id and disposes it on drop', async () => {
    const created = vi.fn();
    const dropped = vi.fn();
    const registry = new ManagedRuntimeRegistry<{ model: string }, ReturnType<typeof runtime>>({
      onCreate: created,
      onDrop: dropped,
    });

    const first = registry.create('coder', { model: 'fast' }, (id) => runtime(id));

    expect(registry.get('coder')).toBe(first);
    expect(registry.getRuntime('coder')).toBe(first.runtime);
    expect(() => registry.create('coder', { model: 'fast' }, (id) => runtime(id))).toThrow(/already mounted/);

    const removed = await registry.drop('coder');

    expect(removed).toBe(first);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(registry.has('coder')).toBe(false);
    expect(created).toHaveBeenCalledWith(first);
    expect(dropped).toHaveBeenCalledWith(first);
  });

  it('replaces runtimes deterministically and keeps entry mutable for host config reloads', async () => {
    const registry = new ManagedRuntimeRegistry<{ model: string }, ReturnType<typeof runtime>>();
    const first = registry.create('coder', { model: 'fast' }, (id) => runtime(id));
    const second = await registry.replace('coder', { model: 'strong' }, (id) => runtime(`${id}-2`));

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.workspace).toBe('/tmp/coder-2');
    expect(registry.get('coder')).toBe(second);

    registry.updateEntry('coder', { model: 'balanced' });

    expect(registry.get('coder')?.entry).toEqual({ model: 'balanced' });
  });

  it('drops matching runtimes and reports dispose errors without leaking mounts', async () => {
    const onDisposeError = vi.fn();
    const registry = new ManagedRuntimeRegistry<{ project?: string }, { runtime: ManagedAgentRuntime }>({
      onDisposeError,
    });
    registry.create('a', { project: '/repo' }, () => ({
      runtime: { dispose: () => { throw new Error('boom'); } } as unknown as ManagedAgentRuntime,
    }));
    registry.create('b', {}, () => runtime('b'));

    const dropped = await registry.dropWhere((mount) => mount.entry.project === '/repo');

    expect(dropped.map((mount) => mount.id)).toEqual(['a']);
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(true);
    expect(onDisposeError.mock.calls[0]?.[0]).toBe('a');
    expect(onDisposeError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('awaits runtime disposal before reporting a mount as dropped', async () => {
    const events: string[] = [];
    const registry = new ManagedRuntimeRegistry<{ model: string }, { runtime: ManagedAgentRuntime }>({
      onDrop: () => events.push('dropped'),
    });
    registry.create('async', { model: 'fast' }, () => ({
      runtime: {
        dispose: async () => {
          await Promise.resolve();
          events.push('disposed');
        },
      } as unknown as ManagedAgentRuntime,
    }));

    const drop = registry.drop('async').then(() => events.push('resolved'));
    expect(events).toEqual([]);
    await drop;

    expect(events).toEqual(['disposed', 'dropped', 'resolved']);
  });
});
