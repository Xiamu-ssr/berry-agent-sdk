// ============================================================
// @berry-agent/runtime — Durable Runtime Orchestration
// ============================================================
// These primitives are intentionally platform-sized but implementation-light:
// hosts can persist "who owns this run?" and "when should this runtime wake?"
// without inventing product-side managed-agent state machines.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z, ZodError, type ZodIssue } from 'zod';

export const RUNTIME_ORCHESTRATION_FILENAME = 'runtime-orchestration.json';

export const RUNTIME_LEASE_STATES = ['active', 'released', 'expired'] as const;
export const RUNTIME_WAKE_STATES = ['pending', 'claimed', 'completed', 'failed', 'cancelled'] as const;

const zNonEmptyString = z.string({
  invalid_type_error: 'expected non-empty string',
  required_error: 'expected non-empty string',
})
  .min(1, 'expected non-empty string');
const zFiniteNumber = z.number({
  invalid_type_error: 'expected finite number',
  required_error: 'expected finite number',
})
  .finite('expected finite number');
const zPositiveNumber = z.number({
  invalid_type_error: 'expected positive number',
  required_error: 'expected positive number',
})
  .finite('expected positive number')
  .positive('expected positive number');
const zNonNegativeInteger = z.number({
  invalid_type_error: 'expected non-negative integer',
  required_error: 'expected non-negative integer',
})
  .int('expected non-negative integer')
  .nonnegative('expected non-negative integer');
const zUnknownRecord = z.record(z.unknown());

export const zRuntimeLeaseState = z.enum(RUNTIME_LEASE_STATES);
export const zRuntimeWakeState = z.enum(RUNTIME_WAKE_STATES);
export const zRuntimeLease = z.object({
  leaseId: zNonEmptyString,
  agentId: zNonEmptyString,
  holderId: zNonEmptyString,
  sessionId: z.string().optional(),
  state: zRuntimeLeaseState,
  acquiredAt: zFiniteNumber,
  expiresAt: zFiniteNumber,
  renewedAt: zFiniteNumber.optional(),
  releasedAt: zFiniteNumber.optional(),
  expiredAt: zFiniteNumber.optional(),
  metadata: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();
export const zRuntimeWake = z.object({
  wakeId: zNonEmptyString,
  agentId: zNonEmptyString,
  sessionId: z.string().optional(),
  reason: zNonEmptyString,
  state: zRuntimeWakeState,
  createdAt: zFiniteNumber,
  dueAt: zFiniteNumber,
  claimedAt: zFiniteNumber.optional(),
  claimAttempts: zNonNegativeInteger.optional(),
  completedAt: zFiniteNumber.optional(),
  failedAt: zFiniteNumber.optional(),
  cancelledAt: zFiniteNumber.optional(),
  errorMessage: z.string().optional(),
  payload: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();
export const zRuntimeOrchestrationSnapshot = z.object({
  leases: z.array(zRuntimeLease, { invalid_type_error: 'expected array', required_error: 'expected array' }),
  wakes: z.array(zRuntimeWake, { invalid_type_error: 'expected array', required_error: 'expected array' }),
}, { invalid_type_error: 'expected object' }).strict();
export const zAcquireRuntimeLeaseInput = z.object({
  agentId: zNonEmptyString,
  holderId: zNonEmptyString,
  ttlMs: zPositiveNumber,
  sessionId: zNonEmptyString.optional(),
  metadata: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();
export const zScheduleRuntimeWakeInput = z.object({
  agentId: zNonEmptyString,
  dueAt: zFiniteNumber,
  reason: zNonEmptyString,
  sessionId: zNonEmptyString.optional(),
  payload: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();
export const zClaimDueWakesOptions = z.object({
  now: zFiniteNumber.optional(),
  limit: zPositiveNumber.optional(),
  staleClaimedMs: zPositiveNumber.optional(),
}, { invalid_type_error: 'expected object' }).strict();

export type RuntimeLeaseState = z.infer<typeof zRuntimeLeaseState>;
export type RuntimeWakeState = z.infer<typeof zRuntimeWakeState>;
export type RuntimeLease = z.infer<typeof zRuntimeLease>;
export type RuntimeWake = z.infer<typeof zRuntimeWake>;
export type RuntimeOrchestrationSnapshot = z.infer<typeof zRuntimeOrchestrationSnapshot>;

export interface RuntimeOrchestrationStore {
  load(): Promise<RuntimeOrchestrationSnapshot>;
  save(snapshot: RuntimeOrchestrationSnapshot): Promise<void>;
}

export interface RuntimeOrchestratorOptions {
  store: RuntimeOrchestrationStore;
  now?: () => number;
  idFactory?: (prefix: 'lease' | 'wake') => string;
}

export type AcquireRuntimeLeaseInput = z.infer<typeof zAcquireRuntimeLeaseInput>;

export type AcquireRuntimeLeaseResult =
  | { acquired: true; lease: RuntimeLease }
  | { acquired: false; active: RuntimeLease };

export type ScheduleRuntimeWakeInput = z.infer<typeof zScheduleRuntimeWakeInput>;

export type ClaimDueWakesOptions = z.infer<typeof zClaimDueWakesOptions>;

export class MemoryRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  private snapshot: RuntimeOrchestrationSnapshot = emptySnapshot();

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  async save(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
  }
}

export class FileRuntimeOrchestrationStore implements RuntimeOrchestrationStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RuntimeOrchestrationSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isNotFoundError(error)) return emptySnapshot();
      throw error;
    }
    return parseRuntimeOrchestrationSnapshot(raw, this.filePath);
  }

  async save(snapshot: RuntimeOrchestrationSnapshot): Promise<void> {
    const parsed = parseSchema(zRuntimeOrchestrationSnapshot, snapshot, this.filePath);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmp, this.filePath);
  }
}

export function runtimeOrchestrationPath(rootDir: string): string {
  if (!rootDir) throw new Error('rootDir is required');
  return join(rootDir, RUNTIME_ORCHESTRATION_FILENAME);
}

export function createFileRuntimeOrchestrationStore(rootDir: string): FileRuntimeOrchestrationStore {
  return new FileRuntimeOrchestrationStore(runtimeOrchestrationPath(rootDir));
}

export class RuntimeOrchestrator {
  private readonly now: () => number;
  private readonly idFactory: (prefix: 'lease' | 'wake') => string;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

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

    const lease: RuntimeLease = {
      leaseId: this.idFactory('lease'),
      agentId: leaseInput.agentId,
      holderId: leaseInput.holderId,
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

  private async loadAndReap(now: number): Promise<RuntimeOrchestrationSnapshot> {
    const snapshot = await this.options.store.load();
    reapExpiredLeases(snapshot, now);
    return snapshot;
  }
}

export function parseRuntimeOrchestrationSnapshot(
  raw: string,
  source = 'runtime orchestration snapshot',
): RuntimeOrchestrationSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSchema(zRuntimeOrchestrationSnapshot, parsed, source);
}

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

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new Error(`Invalid ${formatIssuePath(source, issue?.path ?? [])}: ${formatIssueMessage(issue)}`);
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function emptySnapshot(): RuntimeOrchestrationSnapshot {
  return { leases: [], wakes: [] };
}

function cloneSnapshot(snapshot: RuntimeOrchestrationSnapshot): RuntimeOrchestrationSnapshot {
  return parseSchema(zRuntimeOrchestrationSnapshot, structuredClone(snapshot), 'runtime orchestration snapshot');
}

function defaultIdFactory(prefix: 'lease' | 'wake'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatIssuePath(source: string, path: Array<string | number>): string {
  return path.reduce<string>((out, part) => (
    typeof part === 'number' ? `${out}[${part}]` : `${out}.${part}`
  ), source);
}

function formatIssueMessage(issue: ZodIssue | undefined): string {
  if (!issue) return 'invalid value';
  return issue.message;
}
