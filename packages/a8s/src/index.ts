// ============================================================
// @berry-agent/a8s — Public API
// ============================================================
// "a8s" = agents → orchestration platform. Cluster-level coordinator
// for many workers (each running many agents) inspired by k8s/Nomad
// in shape, but minimal in scope: lease + capacity + scheduling. No
// network policy, no multi-tenant quota — those layer above this.
//
// First release runs everything in one process (workers are
// InProcessWorkerNode). M4 will add HTTP transport behind the same
// WorkerNode contract.

export { ControlPlane } from './control-plane.js';
export type {
  ControlPlaneOptions,
  CreateAgentResult,
  AgentLocation,
} from './control-plane.js';

export {
  InProcessWorkerNode,
} from './worker-node.js';
export type { WorkerNode, WorkerNodeCapacity } from './worker-node.js';

export {
  leastLoadedScheduler,
  createRoundRobinScheduler,
} from './scheduler.js';
export type { Scheduler, SchedulerContext, SchedulerWorkerView } from './scheduler.js';
