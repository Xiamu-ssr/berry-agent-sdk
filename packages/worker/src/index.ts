// ============================================================
// @berry-agent/worker — Public API
// ============================================================
// A worker daemon is the unit that runs N agent runtimes on a single
// machine. Two ways to consume:
//
//   - buildAgentRuntime() — pure factory; products that want to manage
//     the registry themselves can call this directly.
//   - Worker class — full daemon API: holds N mounts, integrates with
//     ManagedRuntimeSupervisor for cross-process lease/wake/failover.
//
// Higher-level "Worker daemon over HTTP" comes in a later milestone.

export { buildAgentRuntime } from './builder.js';
export type { BuiltWorkerRuntime } from './builder.js';

export { Worker, WorkerLeaseConflictError } from './worker.js';
export type {
  WorkerAgentMount,
  WorkerOptions,
  WorkerSupervisorBinding,
} from './worker.js';

export type {
  WorkerAgentSpec,
  WorkerEnvironment,
  WorkerRuntimeHooks,
} from './types.js';
