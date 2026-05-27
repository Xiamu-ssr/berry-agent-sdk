// ============================================================
// @berry-agent/worker — Worker class
// ============================================================
// The Worker is a single-machine daemon that runs N agents. It owns:
//   - a ManagedRuntimeRegistry (live mount lifecycle)
//   - an optional ManagedRuntimeSupervisor (durable lease + cross-process
//     failover; opt-in for multi-worker deployments)
//
// Products (Claw or others) instantiate one Worker per machine and call
// runAgent(spec) instead of wiring ManagedRuntimeRegistry by hand.
// The Worker delegates to buildAgentRuntime() for the actual SDK
// assembly, so the spec/env contract stays the single source of truth.

import { ManagedAgentRuntime } from '@berry-agent/core';
import {
  ManagedRuntimeRegistry,
  ManagedRuntimeSupervisor,
  type ManagedRuntimeMount,
  type ManagedRuntimeSupervisorOptions,
  type RuntimeWorker,
  type RuntimeOrchestrator,
} from '@berry-agent/runtime';
import { buildAgentRuntime, type BuiltWorkerRuntime } from './builder.js';
import type {
  WorkerAgentSpec,
  WorkerEnvironment,
  WorkerRuntimeHooks,
} from './types.js';

export type WorkerAgentMount<TEntry = unknown> = ManagedRuntimeMount<TEntry, BuiltWorkerRuntime>;

export interface WorkerSupervisorBinding
  extends Omit<ManagedRuntimeSupervisorOptions<unknown, BuiltWorkerRuntime>, 'registry'> {
  /** Auto-call startWorker() in constructor. Defaults to true when supervisor
   *  is supplied with a `worker` option. */
  autoStart?: boolean;
}

export interface WorkerOptions {
  env: WorkerEnvironment;
  /** Optional cross-process supervisor. Pass when this worker should
   *  participate in lease/wake/cross-process failover. */
  supervisor?: WorkerSupervisorBinding;
  /** Optional registry callbacks (onCreate / onDrop / onDestroyError). */
  registryHooks?: {
    onCreate?: (mount: WorkerAgentMount) => void;
    onDrop?: (mount: WorkerAgentMount) => void;
    onDestroyError?: (id: string, error: unknown) => void;
  };
}

/**
 * Single-machine agent daemon. Owns N live ManagedAgentRuntime instances
 * plus optional durable lease lifecycle through a ManagedRuntimeSupervisor.
 *
 * Note: this class is generic over the product-side entry shape so
 * Claw's AgentEntry, future products' entry shape, and tests can each
 * keep their own typed metadata associated with each mount without
 * casting.
 */
export class Worker<TEntry = unknown> {
  readonly registry: ManagedRuntimeRegistry<TEntry, BuiltWorkerRuntime>;
  private readonly env: WorkerEnvironment;
  private readonly supervisorBinding?: WorkerSupervisorBinding;
  private supervisorInstance: ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime> | null = null;
  private supervisorStarted = false;

  constructor(options: WorkerOptions) {
    this.env = options.env;
    this.registry = new ManagedRuntimeRegistry<TEntry, BuiltWorkerRuntime>({
      onCreate: options.registryHooks?.onCreate,
      onDrop: options.registryHooks?.onDrop,
      onDestroyError: options.registryHooks?.onDestroyError,
    });
    this.supervisorBinding = options.supervisor;
  }

  /**
   * Run an agent on this worker. Mounts the SDK runtime and registers it.
   *
   * When the worker is in supervisor mode, the supervisor's start() handles
   * lease acquisition; otherwise the local registry is used directly.
   */
  async runAgent(
    agentId: string,
    entry: TEntry,
    spec: WorkerAgentSpec,
    hooks: WorkerRuntimeHooks = {},
  ): Promise<WorkerAgentMount<TEntry>> {
    const supervisor = await this.ensureSupervisor();
    if (supervisor) {
      const result = await supervisor.start({
        agentId,
        entry,
        factory: () => buildAgentRuntime(spec, this.env, hooks),
      });
      if (!result.started) {
        throw new WorkerLeaseConflictError(agentId, result.activeLease.holderId);
      }
      return result.mount as WorkerAgentMount<TEntry>;
    }
    return this.registry.create(agentId, entry, () => buildAgentRuntime(spec, this.env, hooks));
  }

  /**
   * Synchronous variant of runAgent for single-process callers. Throws when
   * the worker was configured with a supervisor — supervisor mode involves
   * durable lease acquisition which must be awaited.
   */
  runAgentSync(
    agentId: string,
    entry: TEntry,
    spec: WorkerAgentSpec,
    hooks: WorkerRuntimeHooks = {},
  ): WorkerAgentMount<TEntry> {
    if (this.supervisorBinding) {
      throw new Error(
        'Worker.runAgentSync() is only valid in single-process mode. '
        + 'Use the async runAgent() when a supervisor is configured.',
      );
    }
    return this.registry.create(agentId, entry, () => buildAgentRuntime(spec, this.env, hooks));
  }

  /**
   * Update an existing mount's entry without destroying the runtime.
   * Useful when a product's AgentEntry config row changes but the runtime
   * does not need a full rebuild.
   */
  updateEntry(agentId: string, entry: TEntry): WorkerAgentMount<TEntry> {
    return this.registry.updateEntry(agentId, entry);
  }

  /**
   * Stop an agent: dispose runtime + release lease (when supervised).
   */
  async stopAgent(agentId: string): Promise<WorkerAgentMount<TEntry> | undefined> {
    if (this.supervisorInstance) {
      return (await this.supervisorInstance.stop(agentId)) as WorkerAgentMount<TEntry> | undefined;
    }
    return this.registry.drop(agentId);
  }

  /** Replace the live runtime for an existing agent. */
  async replaceAgent(
    agentId: string,
    entry: TEntry,
    spec: WorkerAgentSpec,
    hooks: WorkerRuntimeHooks = {},
  ): Promise<WorkerAgentMount<TEntry>> {
    await this.stopAgent(agentId);
    return this.runAgent(agentId, entry, spec, hooks);
  }

  /** Find an agent by id. */
  get(agentId: string): WorkerAgentMount<TEntry> | undefined {
    return this.registry.get(agentId);
  }

  /** Live runtime accessor — throws when the agent is not mounted. */
  runtime(agentId: string): ManagedAgentRuntime {
    const mount = this.registry.get(agentId);
    if (!mount) throw new Error(`Agent "${agentId}" is not running on this worker`);
    return mount.runtime;
  }

  has(agentId: string): boolean {
    return this.registry.has(agentId);
  }

  list(): WorkerAgentMount<TEntry>[] {
    return this.registry.values();
  }

  ids(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Start this worker as a durable cluster participant. Idempotent —
   * subsequent calls return the existing worker entry.
   *
   * Requires the constructor to have received a supervisor binding with
   * a `worker` option (capacity + heartbeatTtlMs).
   */
  async startWorker(): Promise<RuntimeWorker> {
    const supervisor = this.requireSupervisor();
    if (!this.supervisorBinding?.worker) {
      throw new Error(
        'Worker.startWorker() requires supervisor.worker to be configured with capacity + heartbeatTtlMs',
      );
    }
    const entry = await supervisor.startWorker();
    this.supervisorStarted = true;
    return entry;
  }

  /** Cleanly leave the cluster: withdraw worker entry, release leases, stop timers. */
  async stopWorker(): Promise<void> {
    if (this.supervisorInstance) {
      await this.supervisorInstance.stopWorker();
    }
    this.supervisorStarted = false;
  }

  /** Manually trigger a stale-worker sweep. */
  async evictStaleWorkers(): Promise<void> {
    if (this.supervisorInstance) {
      await this.supervisorInstance.evictStaleWorkers();
    }
  }

  /** Tear down all live runtimes and worker registration. */
  async dispose(): Promise<void> {
    await this.stopWorker();
    await this.registry.clear();
  }

  /**
   * Access the underlying RuntimeOrchestrator (when supervisor mode).
   * Hosts use this for wake scheduling, capacity reports, and worker queries.
   */
  orchestrator(): RuntimeOrchestrator | null {
    return this.supervisorBinding?.orchestrator ?? null;
  }

  /**
   * Access the underlying ManagedRuntimeSupervisor when supervisor mode is on.
   * Returns null in single-process mode.
   */
  supervisor(): ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime> | null {
    return this.supervisorInstance;
  }

  /**
   * The current cluster worker entry (when supervisor mode is started).
   * Returns null in single-process mode or before startWorker() runs.
   */
  worker(): RuntimeWorker | null {
    return this.supervisorInstance?.worker() ?? null;
  }

  private async ensureSupervisor(): Promise<
    ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime> | null
  > {
    if (!this.supervisorBinding) return null;
    if (!this.supervisorInstance) {
      this.supervisorInstance = new ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime>({
        ...this.supervisorBinding,
        registry: this.registry,
      });
    }
    if (
      this.supervisorBinding.worker
      && this.supervisorBinding.autoStart !== false
      && !this.supervisorStarted
    ) {
      await this.startWorker();
    }
    return this.supervisorInstance;
  }

  private requireSupervisor(): ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime> {
    if (!this.supervisorBinding) {
      throw new Error('Worker.startWorker() requires a supervisor binding in the constructor');
    }
    if (!this.supervisorInstance) {
      this.supervisorInstance = new ManagedRuntimeSupervisor<TEntry, BuiltWorkerRuntime>({
        ...this.supervisorBinding,
        registry: this.registry,
      });
    }
    return this.supervisorInstance;
  }
}

export class WorkerLeaseConflictError extends Error {
  constructor(public readonly agentId: string, public readonly heldBy: string) {
    super(`Agent "${agentId}" lease is currently held by ${heldBy}`);
    this.name = 'WorkerLeaseConflictError';
  }
}
