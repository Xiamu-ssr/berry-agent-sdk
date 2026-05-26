// ============================================================
// @berry-agent/runtime — Managed Runtime Supervisor
// ============================================================
// The supervisor connects durable orchestration facts to live runtime mounts.
// Hosts choose agent entries and build factories; the SDK owns lease, mount,
// renewal, teardown, wake handoff, and worker registration/heartbeat as one
// boundary.

import {
  ManagedRuntimeRegistry,
  type ManagedRuntimeMount,
  type ManagedRuntimeMountFactory,
  type ManagedRuntimeMountInput,
} from './registry.js';
import {
  RuntimeOrchestrator,
  type ClaimDueWakesOptions,
  type EvictStaleWorkersResult,
  type RuntimeLease,
  type RuntimeWake,
  type RuntimeWorker,
  type ScheduleRuntimeWakeInput,
} from './orchestration.js';
import { unrefTimer } from './timer.js';

export interface ManagedRuntimeSupervisorOptions<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  orchestrator: RuntimeOrchestrator;
  holderId: string;
  leaseTtlMs: number;
  renewIntervalMs?: number;
  /**
   * When set, the supervisor registers itself as a durable worker with the
   * orchestrator. This is required for cross-process eviction: if this
   * supervisor process dies, peers running the same orchestration store can
   * detect a missed heartbeat and reclaim its leases.
   */
  worker?: ManagedRuntimeSupervisorWorkerOptions;
  registry?: ManagedRuntimeRegistry<TEntry, TBuild>;
  onLeaseLost?: (agentId: string, leaseId: string) => void;
  onRenewError?: (agentId: string, leaseId: string, error: unknown) => void;
  /**
   * Called once per remote/dead worker evicted via the orchestrator. The host
   * can use this to reclaim live mounts (e.g. spin up a replacement runtime).
   */
  onWorkerEvicted?: (eviction: EvictStaleWorkersResult) => void;
}

export interface ManagedRuntimeSupervisorWorkerOptions {
  capacity: number;
  heartbeatTtlMs: number;
  heartbeatIntervalMs?: number;
  /** Interval at which this supervisor sweeps for stale peer workers. */
  evictIntervalMs?: number;
  workerId?: string;
  labels?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ManagedRuntimeSupervisorStartInput<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  agentId: string;
  entry: TEntry;
  factory: ManagedRuntimeMountFactory<TEntry, TBuild>;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export type ManagedRuntimeSupervisorStartResult<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> =
  | {
      started: true;
      reused: boolean;
      lease: RuntimeLease;
      mount: ManagedRuntimeMount<TEntry, TBuild>;
    }
  | {
      started: false;
      activeLease: RuntimeLease;
    };

interface RenewalState {
  leaseId: string;
  timer?: ReturnType<typeof setInterval>;
  renewing: boolean;
}

interface WorkerState {
  options: ManagedRuntimeSupervisorWorkerOptions;
  worker: RuntimeWorker | null;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  evictTimer?: ReturnType<typeof setInterval>;
  ready: Promise<RuntimeWorker> | null;
}

export class ManagedRuntimeSupervisor<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  readonly registry: ManagedRuntimeRegistry<TEntry, TBuild>;
  private readonly renewals = new Map<string, RenewalState>();
  private readonly workerState: WorkerState | null;

  constructor(private readonly options: ManagedRuntimeSupervisorOptions<TEntry, TBuild>) {
    if (!options.holderId) throw new Error('holderId is required');
    if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new Error('leaseTtlMs must be a positive number');
    }
    if (options.renewIntervalMs !== undefined && (!Number.isFinite(options.renewIntervalMs) || options.renewIntervalMs <= 0)) {
      throw new Error('renewIntervalMs must be a positive number');
    }
    if (options.worker) {
      if (!Number.isFinite(options.worker.heartbeatTtlMs) || options.worker.heartbeatTtlMs <= 0) {
        throw new Error('worker.heartbeatTtlMs must be a positive number');
      }
      if (options.worker.capacity < 0) {
        throw new Error('worker.capacity must be non-negative');
      }
    }
    this.registry = options.registry ?? new ManagedRuntimeRegistry<TEntry, TBuild>();
    this.workerState = options.worker ? { options: options.worker, worker: null, ready: null } : null;
  }

  /**
   * Register this process as a worker, start heartbeat + eviction sweeper.
   * Idempotent: re-calling returns the same worker entry.
   */
  async startWorker(): Promise<RuntimeWorker> {
    if (!this.workerState) {
      throw new Error('Supervisor was not constructed with a worker option');
    }
    if (this.workerState.ready) return this.workerState.ready;

    const config = this.workerState.options;
    const promise = (async () => {
      const worker = await this.options.orchestrator.registerWorker({
        holderId: this.options.holderId,
        capacity: config.capacity,
        heartbeatTtlMs: config.heartbeatTtlMs,
        workerId: config.workerId,
        labels: config.labels,
        metadata: config.metadata,
      });
      this.workerState!.worker = worker;
      this.scheduleHeartbeat();
      this.scheduleEviction();
      return worker;
    })();
    this.workerState.ready = promise;
    try {
      return await promise;
    } catch (error) {
      this.workerState.ready = null;
      throw error;
    }
  }

  async start(
    input: ManagedRuntimeSupervisorStartInput<TEntry, TBuild>,
  ): Promise<ManagedRuntimeSupervisorStartResult<TEntry, TBuild>> {
    if (!input.agentId) throw new Error('agentId is required');

    const existing = await this.reuseExistingMount(input.agentId);
    if (existing) return existing;

    const workerId = await this.ensureWorkerId();

    const acquired = await this.options.orchestrator.acquireLease({
      agentId: input.agentId,
      holderId: this.options.holderId,
      ttlMs: this.options.leaseTtlMs,
      workerId,
      sessionId: input.sessionId,
      metadata: input.metadata,
    });
    if (!acquired.acquired) {
      return { started: false, activeLease: acquired.active };
    }

    try {
      const mount = this.registry.create(input.agentId, input.entry, input.factory);
      this.trackLease(input.agentId, acquired.lease.leaseId);
      return { started: true, reused: false, lease: acquired.lease, mount };
    } catch (error) {
      await this.options.orchestrator.releaseLease(acquired.lease.leaseId);
      throw error;
    }
  }

  async renew(agentId: string): Promise<RuntimeLease | null> {
    const state = this.renewals.get(agentId);
    if (!state || state.renewing) return null;
    state.renewing = true;
    try {
      const renewed = await this.options.orchestrator.renewLease(state.leaseId, this.options.leaseTtlMs);
      if (!renewed) {
        await this.stop(agentId);
        this.options.onLeaseLost?.(agentId, state.leaseId);
        return null;
      }
      return renewed;
    } finally {
      const current = this.renewals.get(agentId);
      if (current?.leaseId === state.leaseId) current.renewing = false;
    }
  }

  async stop(agentId: string): Promise<ManagedRuntimeMount<TEntry, TBuild> | undefined> {
    if (!agentId) throw new Error('agentId is required');
    const leaseId = this.renewals.get(agentId)?.leaseId;
    this.untrackLease(agentId);
    try {
      return await this.registry.drop(agentId);
    } finally {
      if (leaseId) await this.options.orchestrator.releaseLease(leaseId);
    }
  }

  async clear(): Promise<void> {
    for (const agentId of [...this.registry.keys()]) {
      await this.stop(agentId);
    }
  }

  /**
   * Stop the worker heartbeat + eviction sweepers and withdraw this worker
   * from the orchestrator. Active leases held by this worker become eligible
   * for reuse by peers. Hosts typically call this in their shutdown path.
   */
  async stopWorker(): Promise<void> {
    if (!this.workerState) return;
    if (this.workerState.heartbeatTimer) clearInterval(this.workerState.heartbeatTimer);
    if (this.workerState.evictTimer) clearInterval(this.workerState.evictTimer);
    this.workerState.heartbeatTimer = undefined;
    this.workerState.evictTimer = undefined;
    if (this.workerState.worker) {
      await this.options.orchestrator.withdrawWorker(this.workerState.worker.workerId);
    }
    this.workerState.worker = null;
    this.workerState.ready = null;
  }

  /** Manually trigger a sweep for stale peer workers. */
  async evictStaleWorkers(): Promise<EvictStaleWorkersResult> {
    const result = await this.options.orchestrator.evictStaleWorkers();
    if (result.evicted.length || result.releasedLeases.length) {
      this.options.onWorkerEvicted?.(result);
    }
    return result;
  }

  get(agentId: string): ManagedRuntimeMount<TEntry, TBuild> | undefined {
    return this.registry.get(agentId);
  }

  activeAgentIds(): string[] {
    return [...this.registry.keys()];
  }

  worker(): RuntimeWorker | null {
    return this.workerState?.worker ?? null;
  }

  scheduleWake(input: ScheduleRuntimeWakeInput): Promise<RuntimeWake> {
    return this.options.orchestrator.scheduleWake(input);
  }

  claimDueWakes(options?: ClaimDueWakesOptions): Promise<RuntimeWake[]> {
    return this.options.orchestrator.claimDueWakes(options);
  }

  completeWake(wakeId: string): Promise<RuntimeWake | null> {
    return this.options.orchestrator.completeWake(wakeId);
  }

  failWake(wakeId: string, errorMessage?: string): Promise<RuntimeWake | null> {
    return this.options.orchestrator.failWake(wakeId, errorMessage);
  }

  listPendingWakes(now?: number): Promise<RuntimeWake[]> {
    return this.options.orchestrator.listPendingWakes(now);
  }

  private async ensureWorkerId(): Promise<string | undefined> {
    if (!this.workerState) return undefined;
    if (this.workerState.worker) return this.workerState.worker.workerId;
    const worker = await this.startWorker();
    return worker.workerId;
  }

  private scheduleHeartbeat(): void {
    if (!this.workerState) return;
    const interval = this.workerState.options.heartbeatIntervalMs
      ?? Math.max(1000, Math.floor(this.workerState.options.heartbeatTtlMs / 3));
    if (this.workerState.heartbeatTimer) clearInterval(this.workerState.heartbeatTimer);
    this.workerState.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce().catch(() => {
        // Suppress timer errors — orchestrator throws happen during shutdown.
      });
    }, interval);
    unrefTimer(this.workerState.heartbeatTimer);
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.workerState?.worker) return;
    const worker = this.workerState.worker;
    const refreshed = await this.options.orchestrator.heartbeatWorker(
      worker.workerId,
      this.workerState.options.heartbeatTtlMs,
    );
    if (refreshed) {
      this.workerState.worker = refreshed;
    } else {
      // Our entry was evicted/withdrawn by a peer. Stop heartbeating and let
      // the host decide what to do via onWorkerEvicted (see eviction sweep).
      if (this.workerState.heartbeatTimer) clearInterval(this.workerState.heartbeatTimer);
      this.workerState.heartbeatTimer = undefined;
      this.workerState.worker = null;
    }
  }

  private scheduleEviction(): void {
    if (!this.workerState) return;
    const interval = this.workerState.options.evictIntervalMs;
    if (interval === undefined) return;
    if (this.workerState.evictTimer) clearInterval(this.workerState.evictTimer);
    this.workerState.evictTimer = setInterval(() => {
      void this.evictStaleWorkers().catch(() => {});
    }, interval);
    unrefTimer(this.workerState.evictTimer);
  }

  private async reuseExistingMount(
    agentId: string,
  ): Promise<ManagedRuntimeSupervisorStartResult<TEntry, TBuild> | null> {
    const mount = this.registry.get(agentId);
    if (!mount) return null;

    const state = this.renewals.get(agentId);
    const lease = state ? await this.options.orchestrator.getActiveLease(agentId) : null;
    if (lease && lease.leaseId === state?.leaseId) {
      return { started: true, reused: true, lease, mount };
    }

    await this.stop(agentId);
    return null;
  }

  private trackLease(agentId: string, leaseId: string): void {
    this.untrackLease(agentId);
    const state: RenewalState = { leaseId, renewing: false };
    const interval = this.options.renewIntervalMs;
    if (interval !== undefined) {
      state.timer = setInterval(() => {
        void this.renew(agentId).catch((error) => {
          this.options.onRenewError?.(agentId, leaseId, error);
        });
      }, interval);
      unrefTimer(state.timer);
    }
    this.renewals.set(agentId, state);
  }

  private untrackLease(agentId: string): void {
    const existing = this.renewals.get(agentId);
    if (existing?.timer) clearInterval(existing.timer);
    this.renewals.delete(agentId);
  }
}
