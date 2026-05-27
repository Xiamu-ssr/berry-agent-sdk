// ============================================================
// @berry-agent/worker — Public API
// ============================================================
// A worker daemon is the unit that runs N agent runtimes on a single
// machine. This first release exposes the core builder used by every
// product host. Higher-level "Worker" class with registry/lease/HTTP
// surface will follow in subsequent milestones.

export { buildAgentRuntime } from './builder.js';
export type { BuiltWorkerRuntime } from './builder.js';

export type {
  WorkerAgentSpec,
  WorkerEnvironment,
  WorkerRuntimeHooks,
} from './types.js';
