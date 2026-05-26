import type { ManagedAgentRuntime } from '@berry-agent/core';

export interface ManagedRuntimeMountInput {
  runtime: ManagedAgentRuntime;
}

export type ManagedRuntimeMount<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> = TBuild & {
  id: string;
  entry: TEntry;
};

export type ManagedRuntimeMountFactory<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> = (id: string, entry: TEntry) => TBuild;

export interface ManagedRuntimeRegistryOptions<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  onCreate?: (mount: ManagedRuntimeMount<TEntry, TBuild>) => void;
  onDrop?: (mount: ManagedRuntimeMount<TEntry, TBuild>) => void;
  onDestroyError?: (id: string, error: unknown) => void;
}

/**
 * Owns host-mounted managed runtime instances.
 *
 * Host products still decide which agent ids exist and how config maps into a
 * runtime build. The SDK owns the boring but important lifecycle semantics:
 * exactly one live runtime per id, deterministic replacement, and teardown
 * before a mount disappears from the host cache.
 */
export class ManagedRuntimeRegistry<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  private readonly mounts = new Map<string, ManagedRuntimeMount<TEntry, TBuild>>();

  constructor(private readonly options: ManagedRuntimeRegistryOptions<TEntry, TBuild> = {}) {}

  get(id: string): ManagedRuntimeMount<TEntry, TBuild> | undefined {
    return this.mounts.get(id);
  }

  getRuntime(id: string): ManagedAgentRuntime | undefined {
    return this.mounts.get(id)?.runtime;
  }

  has(id: string): boolean {
    return this.mounts.has(id);
  }

  keys(): IterableIterator<string> {
    return this.mounts.keys();
  }

  values(): ManagedRuntimeMount<TEntry, TBuild>[] {
    return [...this.mounts.values()];
  }

  create(
    id: string,
    entry: TEntry,
    factory: ManagedRuntimeMountFactory<TEntry, TBuild>,
  ): ManagedRuntimeMount<TEntry, TBuild> {
    if (this.mounts.has(id)) {
      throw new Error(`Managed runtime already mounted: ${id}`);
    }
    return this.store(id, entry, factory(id, entry));
  }

  getOrCreate(
    id: string,
    entry: TEntry,
    factory: ManagedRuntimeMountFactory<TEntry, TBuild>,
  ): ManagedRuntimeMount<TEntry, TBuild> {
    return this.get(id) ?? this.create(id, entry, factory);
  }

  async replace(
    id: string,
    entry: TEntry,
    factory: ManagedRuntimeMountFactory<TEntry, TBuild>,
  ): Promise<ManagedRuntimeMount<TEntry, TBuild>> {
    await this.drop(id);
    return this.create(id, entry, factory);
  }

  updateEntry(id: string, entry: TEntry): ManagedRuntimeMount<TEntry, TBuild> {
    const mount = this.mounts.get(id);
    if (!mount) throw new Error(`Managed runtime is not mounted: ${id}`);
    mount.entry = entry;
    return mount;
  }

  async drop(id: string): Promise<ManagedRuntimeMount<TEntry, TBuild> | undefined> {
    const mount = this.mounts.get(id);
    if (!mount) return undefined;
    await this.destroyMount(mount);
    this.mounts.delete(id);
    this.options.onDrop?.(mount);
    return mount;
  }

  async dropWhere(
    predicate: (mount: ManagedRuntimeMount<TEntry, TBuild>) => boolean,
  ): Promise<ManagedRuntimeMount<TEntry, TBuild>[]> {
    const dropped: ManagedRuntimeMount<TEntry, TBuild>[] = [];
    for (const mount of this.values()) {
      if (!predicate(mount)) continue;
      const removed = await this.drop(mount.id);
      if (removed) dropped.push(removed);
    }
    return dropped;
  }

  async clear(): Promise<void> {
    for (const id of [...this.mounts.keys()]) {
      await this.drop(id);
    }
  }

  private store(id: string, entry: TEntry, build: TBuild): ManagedRuntimeMount<TEntry, TBuild> {
    const mount = Object.assign(build, { id, entry }) as ManagedRuntimeMount<TEntry, TBuild>;
    this.mounts.set(id, mount);
    this.options.onCreate?.(mount);
    return mount;
  }

  private async destroyMount(mount: ManagedRuntimeMount<TEntry, TBuild>): Promise<void> {
    try {
      await mount.runtime.destroy();
    } catch (error) {
      this.options.onDestroyError?.(mount.id, error);
    }
  }
}
