// ============================================================
// @berry-agent/runtime — Durable Runtime Orchestration
// ============================================================
// `RuntimeOrchestrator` owns the lease / wake / worker state machines.
// Schemas and persistent stores live in companion files so alternative
// stores (S3, Postgres, Redis) and downstream consumers can import the
// contract without dragging the orchestrator logic in.

import {
  zAcquireRuntimeLeaseInput,
  zClaimDueWakesOptions,
  zRegisterRuntimeWorkerInput,
  zScheduleRuntimeWakeInput,
  type AcquireRuntimeLeaseInput,
  type AcquireRuntimeLeaseResult,
  type ClaimDueWakesOptions,
  type EvictStaleWorkersResult,
  type RegisterRuntimeWorkerInput,
  type RuntimeLease,
  type RuntimeOrchestrationSnapshot,
  type RuntimeWake,
  type RuntimeWorker,
  type RuntimeWorkerCapacityReport,
  type ScheduleRuntimeWakeInput,
} from './orchestration-schemas.js';
import { parseSchema, type RuntimeOrchestrationStore } from './orchestration-store.js';

// ----- Public re-exports — keep the orchestration.js import surface stable -----
export {
  RUNTIME_LEASE_STATES,
  RUNTIME_ORCHESTRATION_FILENAME,
  RUNTIME_WAKE_STATES,
  RUNTIME_WORKER_STATES,
  zAcquireRuntimeLeaseInput,
  zClaimDueWakesOptions,
  zRegisterRuntimeWorkerInput,
  zRuntimeLease,
  zRuntimeLeaseState,
  zRuntimeOrchestrationSnapshot,
  zRuntimeWake,
  zRuntimeWakeState,
  zRuntimeWorker,
  zRuntimeWorkerState,
  zScheduleRuntimeWakeInput,
} from './orchestration-schemas.js';
export type {
  AcquireRuntimeLeaseInput,
  AcquireRuntimeLeaseResult,
  ClaimDueWakesOptions,
  EvictStaleWorkersResult,
  RegisterRuntimeWorkerInput,
  RuntimeLease,
  RuntimeLeaseState,
  RuntimeOrchestrationSnapshot,
  RuntimeWake,
  RuntimeWakeState,
  RuntimeWorker,
  RuntimeWorkerCapacityReport,
  RuntimeWorkerState,
  ScheduleRuntimeWakeInput,
} from './orchestration-schemas.js';
export {
  FileRuntimeOrchestrationStore,
  MemoryRuntimeOrchestrationStore,
  createFileRuntimeOrchestrationStore,
  parseRuntimeOrchestrationSnapshot,
  runtimeOrchestrationPath,
} from './orchestration-store.js';
export type { RuntimeOrchestrationStore } from './orchestration-store.js';

// ----- Orchestrator -----

export interface RuntimeOrchestratorOptions {
  store: RuntimeOrchestrationStore;
  now?: () => number;
  idFactory?: (prefix: 'lease' | 'wake' | 'worker') => string;
}

export class RuntimeOrchestrator {
  private readonly now: () => number;
  private readonly idFactory: (prefix: 'lease' | 'wake' | 'worker') => string;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  // ============================================================
  // Lease state machine
  // ============================================================

  async acquireLease(input: AcquireRuntimeLeaseInput): Promise<AcquireRuntimeLeaseResult> {
    const leaseInput = parseSchema(zAcquireRuntimeLeaseInput, input, 'AcquireRuntimeLeaseInput');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const active = snapshot.leases.find(
      (lease) => lease.agentId === leaseInput.agentId && isActiveLease(lease, now),
    );
    if (active) {
      await this.options.store.save(snapshot);
      return { acquired: false, active };
    }

    if (leaseInput.workerId !== undefined) {
      const worker = snapshot.workers.find((entry) => entry.workerId === leaseInput.workerId);
      if (!worker || worker.state !== 'active') {
        await this.options.store.save(snapshot);
        throw new Error(`worker ${leaseInput.workerId} is not accepting new leases`);
      }
      const activeForWorker = snapshot.leases.filter(
        (lease) => lease.workerId === worker.workerId && isActiveLease(lease, now),
      ).length;
      if (activeForWorker >= worker.capacity) {
        await this.options.store.save(snapshot);
        throw new Error(`worker ${worker.workerId} is at capacity (${worker.capacity})`);
      }
    }

    const lease: RuntimeLease = {
      leaseId: this.idFactory('lease'),
      agentId: leaseInput.agentId,
      holderId: leaseInput.holderId,
      workerId: leaseInput.workerId,
      sessionId: leaseInput.sessionId,
      state: 'active',
      acquiredAt: now,
      expiresAt: now + leaseInput.ttlMs,
      metadata: leaseInput.metadata,
    };
    snapshot.leases.push(lease);
    await this.options.store.save(snapshot);
    return { acquired: true, lease };
  }

  async renewLease(leaseId: string, ttlMs: number): Promise<RuntimeLease | null> {
    if (!leaseId) throw new Error('leaseId is required');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive number');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const lease = snapshot.leases.find((item) => item.leaseId === leaseId);
    if (!lease || !isActiveLease(lease, now)) {
      await this.options.store.save(snapshot);
      return null;
    }
    lease.expiresAt = now + ttlMs;
    lease.renewedAt = now;
    await this.options.store.save(snapshot);
    return lease;
  }

  async releaseLease(leaseId: string): Promise<RuntimeLease | null> {
    if (!leaseId) throw new Error('leaseId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const lease = snapshot.leases.find((item) => item.leaseId === leaseId);
    if (!lease || lease.state !== 'active') {
      await this.options.store.save(snapshot);
      return null;
    }
    lease.state = 'released';
    lease.releasedAt = now;
    await this.options.store.save(snapshot);
    return lease;
  }

  async getActiveLease(agentId: string): Promise<RuntimeLease | null> {
    if (!agentId) throw new Error('agentId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    await this.options.store.save(snapshot);
    return snapshot.leases.find((lease) => lease.agentId === agentId && isActiveLease(lease, now)) ?? null;
  }

  async listLeases(): Promise<RuntimeLease[]> {
    const snapshot = await this.loadAndReap(this.now());
    await this.options.store.save(snapshot);
    return [...snapshot.leases];
  }

  // ============================================================
  // Wake state machine
  // ============================================================

  async scheduleWake(input: ScheduleRuntimeWakeInput): Promise<RuntimeWake> {
    const wakeInput = parseSchema(zScheduleRuntimeWakeInput, input, 'ScheduleRuntimeWakeInput');
    const snapshot = await this.loadAndReap(this.now());
    const wake: RuntimeWake = {
      wakeId: this.idFactory('wake'),
      agentId: wakeInput.agentId,
      sessionId: wakeInput.sessionId,
      reason: wakeInput.reason,
      state: 'pending',
      createdAt: this.now(),
      dueAt: wakeInput.dueAt,
      payload: wakeInput.payload,
    };
    snapshot.wakes.push(wake);
    await this.options.store.save(snapshot);
    return wake;
  }

  async cancelWake(wakeId: string): Promise<RuntimeWake | null> {
    if (!wakeId) throw new Error('wakeId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const wake = snapshot.wakes.find((item) => item.wakeId === wakeId);
    if (!wake || wake.state !== 'pending') {
      await this.options.store.save(snapshot);
      return null;
    }
    wake.state = 'cancelled';
    wake.cancelledAt = now;
    await this.options.store.save(snapshot);
    return wake;
  }

  async completeWake(wakeId: string): Promise<RuntimeWake | null> {
    if (!wakeId) throw new Error('wakeId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const wake = snapshot.wakes.find((item) => item.wakeId === wakeId);
    if (!wake || wake.state !== 'claimed') {
      await this.options.store.save(snapshot);
      return null;
    }
    wake.state = 'completed';
    wake.completedAt = now;
    await this.options.store.save(snapshot);
    return wake;
  }

  async failWake(wakeId: string, errorMessage?: string): Promise<RuntimeWake | null> {
    if (!wakeId) throw new Error('wakeId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const wake = snapshot.wakes.find((item) => item.wakeId === wakeId);
    if (!wake || wake.state !== 'claimed') {
      await this.options.store.save(snapshot);
      return null;
    }
    wake.state = 'failed';
    wake.failedAt = now;
    if (errorMessage) wake.errorMessage = errorMessage;
    await this.options.store.save(snapshot);
    return wake;
  }

  async claimDueWakes(options: ClaimDueWakesOptions = {}): Promise<RuntimeWake[]> {
    const claimOptions = parseSchema(zClaimDueWakesOptions, options, 'ClaimDueWakesOptions');
    const now = claimOptions.now ?? this.now();
    const limit = claimOptions.limit ?? Number.POSITIVE_INFINITY;
    const snapshot = await this.loadAndReap(now);
    if (claimOptions.staleClaimedMs !== undefined) {
      requeueStaleClaimedWakes(snapshot, now, claimOptions.staleClaimedMs);
    }
    const due = snapshot.wakes
      .filter((wake) => wake.state === 'pending' && wake.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt)
      .slice(0, limit);
    for (const wake of due) {
      wake.state = 'claimed';
      wake.claimedAt = now;
      wake.claimAttempts = (wake.claimAttempts ?? 0) + 1;
    }
    await this.options.store.save(snapshot);
    return due;
  }

  async listPendingWakes(now = this.now()): Promise<RuntimeWake[]> {
    const snapshot = await this.loadAndReap(now);
    await this.options.store.save(snapshot);
    return snapshot.wakes
      .filter((wake) => wake.state === 'pending')
      .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
  }

  // ============================================================
  // Worker registry
  // ============================================================

  async registerWorker(input: RegisterRuntimeWorkerInput): Promise<RuntimeWorker> {
    const workerInput = parseSchema(zRegisterRuntimeWorkerInput, input, 'RegisterRuntimeWorkerInput');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const workerId = workerInput.workerId ?? this.idFactory('worker');
    const existing = snapshot.workers.find((entry) => entry.workerId === workerId);
    const worker: RuntimeWorker = existing
      ? {
          ...existing,
          holderId: workerInput.holderId,
          state: 'active',
          capacity: workerInput.capacity,
          heartbeatAt: now,
          heartbeatExpiresAt: now + workerInput.heartbeatTtlMs,
          labels: workerInput.labels ?? existing.labels,
          metadata: workerInput.metadata ?? existing.metadata,
          drainedAt: undefined,
          evictedAt: undefined,
          withdrawnAt: undefined,
        }
      : {
          workerId,
          holderId: workerInput.holderId,
          state: 'active',
          capacity: workerInput.capacity,
          registeredAt: now,
          heartbeatAt: now,
          heartbeatExpiresAt: now + workerInput.heartbeatTtlMs,
          labels: workerInput.labels,
          metadata: workerInput.metadata,
        };
    if (existing) {
      const index = snapshot.workers.indexOf(existing);
      snapshot.workers[index] = worker;
    } else {
      snapshot.workers.push(worker);
    }
    await this.options.store.save(snapshot);
    return worker;
  }

  async heartbeatWorker(workerId: string, heartbeatTtlMs: number): Promise<RuntimeWorker | null> {
    if (!workerId) throw new Error('workerId is required');
    if (!Number.isFinite(heartbeatTtlMs) || heartbeatTtlMs <= 0) {
      throw new Error('heartbeatTtlMs must be a positive number');
    }
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const worker = snapshot.workers.find((entry) => entry.workerId === workerId);
    if (!worker || worker.state === 'evicted' || worker.state === 'withdrawn') {
      await this.options.store.save(snapshot);
      return null;
    }
    worker.heartbeatAt = now;
    worker.heartbeatExpiresAt = now + heartbeatTtlMs;
    await this.options.store.save(snapshot);
    return worker;
  }

  async drainWorker(workerId: string): Promise<RuntimeWorker | null> {
    if (!workerId) throw new Error('workerId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const worker = snapshot.workers.find((entry) => entry.workerId === workerId);
    if (!worker || worker.state !== 'active') {
      await this.options.store.save(snapshot);
      return null;
    }
    worker.state = 'draining';
    worker.drainedAt = now;
    await this.options.store.save(snapshot);
    return worker;
  }

  async withdrawWorker(workerId: string): Promise<EvictStaleWorkersResult | null> {
    if (!workerId) throw new Error('workerId is required');
    const now = this.now();
    const snapshot = await this.loadAndReap(now);
    const worker = snapshot.workers.find((entry) => entry.workerId === workerId);
    if (!worker || worker.state === 'withdrawn' || worker.state === 'evicted') {
      await this.options.store.save(snapshot);
      return null;
    }
    worker.state = 'withdrawn';
    worker.withdrawnAt = now;
    const releasedLeases = releaseLeasesForWorker(snapshot, workerId, now);
    await this.options.store.save(snapshot);
    return { evicted: [worker], releasedLeases };
  }

  async evictStaleWorkers(now = this.now()): Promise<EvictStaleWorkersResult> {
    const snapshot = await this.loadAndReap(now);
    const evicted: RuntimeWorker[] = [];
    const releasedLeases: RuntimeLease[] = [];
    for (const worker of snapshot.workers) {
      const live = worker.state === 'active' || worker.state === 'draining';
      if (!live) continue;
      if (worker.heartbeatExpiresAt > now) continue;
      worker.state = 'evicted';
      worker.evictedAt = now;
      evicted.push(worker);
      releasedLeases.push(...releaseLeasesForWorker(snapshot, worker.workerId, now));
    }
    await this.options.store.save(snapshot);
    return { evicted, releasedLeases };
  }

  async listWorkers(): Promise<RuntimeWorker[]> {
    const snapshot = await this.loadAndReap(this.now());
    await this.options.store.save(snapshot);
    return [...snapshot.workers];
  }

  async workerCapacityReport(now = this.now()): Promise<RuntimeWorkerCapacityReport[]> {
    const snapshot = await this.loadAndReap(now);
    await this.options.store.save(snapshot);
    return snapshot.workers.map((worker) => {
      const activeLeases = snapshot.leases.filter(
        (lease) => lease.workerId === worker.workerId && isActiveLease(lease, now),
      ).length;
      return {
        worker,
        activeLeases,
        available: Math.max(0, worker.capacity - activeLeases),
      };
    });
  }

  private async loadAndReap(now: number): Promise<RuntimeOrchestrationSnapshot> {
    const snapshot = await this.options.store.load();
    reapExpiredLeases(snapshot, now);
    return snapshot;
  }
}

// ----- Private helpers -----

function reapExpiredLeases(snapshot: RuntimeOrchestrationSnapshot, now: number): void {
  for (const lease of snapshot.leases) {
    if (lease.state === 'active' && lease.expiresAt <= now) {
      lease.state = 'expired';
      lease.expiredAt = now;
    }
  }
}

function requeueStaleClaimedWakes(
  snapshot: RuntimeOrchestrationSnapshot,
  now: number,
  staleClaimedMs: number,
): void {
  for (const wake of snapshot.wakes) {
    if (wake.state === 'claimed' && wake.claimedAt !== undefined && wake.claimedAt + staleClaimedMs <= now) {
      wake.state = 'pending';
    }
  }
}

function isActiveLease(lease: RuntimeLease, now: number): boolean {
  return lease.state === 'active' && lease.expiresAt > now;
}

function releaseLeasesForWorker(
  snapshot: RuntimeOrchestrationSnapshot,
  workerId: string,
  now: number,
): RuntimeLease[] {
  const released: RuntimeLease[] = [];
  for (const lease of snapshot.leases) {
    if (lease.workerId !== workerId) continue;
    if (lease.state !== 'active') continue;
    lease.state = 'expired';
    lease.expiredAt = now;
    released.push(lease);
  }
  return released;
}

function defaultIdFactory(prefix: 'lease' | 'wake' | 'worker'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
