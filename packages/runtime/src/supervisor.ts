// ============================================================
// @berry-agent/runtime — Managed Runtime Supervisor
// ============================================================
// The supervisor connects durable orchestration facts to live runtime mounts.
// Hosts choose agent entries and build factories; the SDK owns lease, mount,
// renewal, teardown, and wake handoff semantics as one boundary.

import {
  ManagedRuntimeRegistry,
  type ManagedRuntimeMount,
  type ManagedRuntimeMountFactory,
  type ManagedRuntimeMountInput,
} from './registry.js';
import {
  RuntimeOrchestrator,
  type ClaimDueWakesOptions,
  type RuntimeLease,
  type RuntimeWake,
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
  registry?: ManagedRuntimeRegistry<TEntry, TBuild>;
  onLeaseLost?: (agentId: string, leaseId: string) => void;
  onRenewError?: (agentId: string, leaseId: string, error: unknown) => void;
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

export class ManagedRuntimeSupervisor<
  TEntry,
  TBuild extends ManagedRuntimeMountInput = ManagedRuntimeMountInput,
> {
  readonly registry: ManagedRuntimeRegistry<TEntry, TBuild>;
  private readonly renewals = new Map<string, RenewalState>();

  constructor(private readonly options: ManagedRuntimeSupervisorOptions<TEntry, TBuild>) {
    if (!options.holderId) throw new Error('holderId is required');
    if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new Error('leaseTtlMs must be a positive number');
    }
    if (options.renewIntervalMs !== undefined && (!Number.isFinite(options.renewIntervalMs) || options.renewIntervalMs <= 0)) {
      throw new Error('renewIntervalMs must be a positive number');
    }
    this.registry = options.registry ?? new ManagedRuntimeRegistry<TEntry, TBuild>();
  }

  async start(
    input: ManagedRuntimeSupervisorStartInput<TEntry, TBuild>,
  ): Promise<ManagedRuntimeSupervisorStartResult<TEntry, TBuild>> {
    if (!input.agentId) throw new Error('agentId is required');

    const existing = await this.reuseExistingMount(input.agentId);
    if (existing) return existing;

    const acquired = await this.options.orchestrator.acquireLease({
      agentId: input.agentId,
      holderId: this.options.holderId,
      ttlMs: this.options.leaseTtlMs,
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

  get(agentId: string): ManagedRuntimeMount<TEntry, TBuild> | undefined {
    return this.registry.get(agentId);
  }

  activeAgentIds(): string[] {
    return [...this.registry.keys()];
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
