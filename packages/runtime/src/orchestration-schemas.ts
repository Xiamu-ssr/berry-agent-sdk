// ============================================================
// @berry-agent/runtime — Orchestration Schemas
// ============================================================
// All zod schemas and type aliases for durable runtime orchestration.
// Kept separate from the orchestrator class so the wire/persistence
// contract can be imported without dragging the orchestrator code in.

import { z } from 'zod';

export const RUNTIME_ORCHESTRATION_FILENAME = 'runtime-orchestration.json';

export const RUNTIME_LEASE_STATES = ['active', 'released', 'expired'] as const;
export const RUNTIME_WAKE_STATES = ['pending', 'claimed', 'completed', 'failed', 'cancelled'] as const;
export const RUNTIME_WORKER_STATES = ['active', 'draining', 'evicted', 'withdrawn'] as const;

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
export const zRuntimeWorkerState = z.enum(RUNTIME_WORKER_STATES);

export const zRuntimeLease = z.object({
  leaseId: zNonEmptyString,
  agentId: zNonEmptyString,
  holderId: zNonEmptyString,
  workerId: z.string().optional(),
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

export const zRuntimeWorker = z.object({
  workerId: zNonEmptyString,
  holderId: zNonEmptyString,
  state: zRuntimeWorkerState,
  capacity: zNonNegativeInteger,
  registeredAt: zFiniteNumber,
  heartbeatAt: zFiniteNumber,
  heartbeatExpiresAt: zFiniteNumber,
  drainedAt: zFiniteNumber.optional(),
  evictedAt: zFiniteNumber.optional(),
  withdrawnAt: zFiniteNumber.optional(),
  labels: z.record(z.string()).optional(),
  metadata: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();

export const zRuntimeOrchestrationSnapshot = z.object({
  leases: z.array(zRuntimeLease, { invalid_type_error: 'expected array', required_error: 'expected array' }),
  wakes: z.array(zRuntimeWake, { invalid_type_error: 'expected array', required_error: 'expected array' }),
  workers: z.array(zRuntimeWorker, { invalid_type_error: 'expected array', required_error: 'expected array' }),
}, { invalid_type_error: 'expected object' }).strict();

export const zAcquireRuntimeLeaseInput = z.object({
  agentId: zNonEmptyString,
  holderId: zNonEmptyString,
  ttlMs: zPositiveNumber,
  sessionId: zNonEmptyString.optional(),
  workerId: zNonEmptyString.optional(),
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

export const zRegisterRuntimeWorkerInput = z.object({
  holderId: zNonEmptyString,
  capacity: zNonNegativeInteger,
  heartbeatTtlMs: zPositiveNumber,
  workerId: zNonEmptyString.optional(),
  labels: z.record(z.string()).optional(),
  metadata: zUnknownRecord.optional(),
}, { invalid_type_error: 'expected object' }).strict();

export type RuntimeLeaseState = z.infer<typeof zRuntimeLeaseState>;
export type RuntimeWakeState = z.infer<typeof zRuntimeWakeState>;
export type RuntimeWorkerState = z.infer<typeof zRuntimeWorkerState>;
export type RuntimeLease = z.infer<typeof zRuntimeLease>;
export type RuntimeWake = z.infer<typeof zRuntimeWake>;
export type RuntimeWorker = z.infer<typeof zRuntimeWorker>;
export type RuntimeOrchestrationSnapshot = z.infer<typeof zRuntimeOrchestrationSnapshot>;
export type AcquireRuntimeLeaseInput = z.infer<typeof zAcquireRuntimeLeaseInput>;
export type ScheduleRuntimeWakeInput = z.infer<typeof zScheduleRuntimeWakeInput>;
export type ClaimDueWakesOptions = z.infer<typeof zClaimDueWakesOptions>;
export type RegisterRuntimeWorkerInput = z.infer<typeof zRegisterRuntimeWorkerInput>;

export type AcquireRuntimeLeaseResult =
  | { acquired: true; lease: RuntimeLease }
  | { acquired: false; active: RuntimeLease };

export interface RuntimeWorkerCapacityReport {
  worker: RuntimeWorker;
  activeLeases: number;
  available: number;
}

export interface EvictStaleWorkersResult {
  evicted: RuntimeWorker[];
  releasedLeases: RuntimeLease[];
}
