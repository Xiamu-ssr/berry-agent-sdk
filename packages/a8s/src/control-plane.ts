// ============================================================
// @berry-agent/a8s — Control Plane
// ============================================================
// The cluster-level coordinator. Products (Claw or others) call:
//   - createAgent(spec, entry) → picks a worker, mounts the agent
//   - deleteAgent(id) → asks the owning worker to stop, releases lease
//   - openAgent(id) → returns an AgentSession to drive the agent
//   - listAgents() / getAgentLocation(id) → cluster-wide view
//   - scheduleWake() / claimDueWakes() → cross-worker background jobs
//
// Internally the ControlPlane keeps a worker registry plus a
// RuntimeOrchestrator as the durable fact source. The orchestrator's store
// is what makes this M3 piece composable with M2 (SQLite/Postgres):
// swap MemoryRuntimeOrchestrationStore for a real one and the same code
// participates in cross-process leases.
//
// Failure model: assignments() is an in-memory cache rebuilt from the
// orchestrator. After a process crash, call hydrateAssignments() before
// serving traffic so getAgentLocation/openAgent see the durable truth.

import type {
  RuntimeOrchestrator,
  RuntimeWake,
  ScheduleRuntimeWakeInput,
} from '@berry-agent/runtime';
import type { WorkerAgentSpec, WorkerRuntimeHooks } from '@berry-agent/worker';
import type { AgentSession } from './agent-session.js';
import { createLeastLoadedScheduler, type Scheduler, type SchedulerWorkerView } from './scheduler.js';
import type { WorkerNode, WorkerNodeCapacity } from './worker-node.js';

export interface ControlPlaneOptions<TEntry> {
  orchestrator: RuntimeOrchestrator;
  scheduler?: Scheduler<TEntry>;
  /** Logger used for scheduler decisions and stale-worker eviction. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface CreateAgentResult {
  agentId: string;
  workerId: string;
}

export interface AgentLocation {
  agentId: string;
  workerId: string | null;
}

export interface HydrateAssignmentsResult {
  /** Agent → worker mappings restored from active leases. */
  restored: AgentLocation[];
  /** Agent leases whose workerId is unknown to this ControlPlane (worker
   *  hasn't reconnected yet). Callers may surface as warnings. */
  unowned: Array<{ agentId: string; workerId: string }>;
}

export class ControlPlane<TEntry = unknown> {
  private readonly workers = new Map<string, WorkerNode<TEntry>>();
  private readonly assignments = new Map<string, string>(); // agentId → workerId
  private readonly scheduler: Scheduler<TEntry>;
  /**
   * Durable orchestration store. Exposed (read-only via TS) so a8s-server
   * bootstrap helpers and tests can drive the same orchestrator that the
   * plane uses for lease acquisition, without going through an HTTP round
   * trip back into ourselves.
   */
  readonly orchestrator: RuntimeOrchestrator;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(options: ControlPlaneOptions<TEntry>) {
    this.orchestrator = options.orchestrator;
    this.scheduler = options.scheduler ?? createLeastLoadedScheduler<TEntry>();
    this.logger = options.logger ?? console;
  }

  /** Add a worker node (in-process or remote). Idempotent on workerId. */
  addWorker(node: WorkerNode<TEntry>): void {
    this.workers.set(node.workerId, node);
  }

  /** Remove a worker. Caller is responsible for stopping its agents first. */
  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
    for (const [agentId, owner] of [...this.assignments]) {
      if (owner === workerId) this.assignments.delete(agentId);
    }
  }

  listWorkers(): WorkerNode<TEntry>[] {
    return [...this.workers.values()];
  }

  workerCount(): number {
    return this.workers.size;
  }

  /**
   * Schedule + mount an agent. Throws if no worker has capacity, or if the
   * agent is already assigned somewhere.
   *
   * `options.preferredMachine` is a soft hint passed to the scheduler:
   * when set, workers whose `labels.machine` matches win over peers,
   * giving us same-host failover affinity (re-mount the agent where
   * its on-disk home already lives).
   */
  async createAgent(
    spec: WorkerAgentSpec,
    entry: TEntry,
    options: { hooks?: WorkerRuntimeHooks; preferredMachine?: string } = {},
  ): Promise<CreateAgentResult> {
    if (this.assignments.has(spec.agentId)) {
      throw new Error(`Agent "${spec.agentId}" is already running on worker ${this.assignments.get(spec.agentId)}`);
    }
    if (this.workers.size === 0) {
      throw new Error('No workers registered with the control plane');
    }

    const workerViews = await this.gatherWorkerViews();
    const node = await this.scheduler.pick({
      agentId: spec.agentId,
      entry,
      workers: workerViews,
      preferredMachine: options.preferredMachine,
    });
    if (!node) {
      throw new Error(`No worker has capacity for agent "${spec.agentId}"`);
    }

    try {
      await node.runAgent(spec.agentId, entry, spec, options.hooks);
    } catch (error) {
      this.logger.warn?.(`[a8s] runAgent failed on worker ${node.workerId}:`, error);
      throw error;
    }
    this.assignments.set(spec.agentId, node.workerId);
    return { agentId: spec.agentId, workerId: node.workerId };
  }

  /** Stop and unassign an agent. */
  async deleteAgent(agentId: string): Promise<void> {
    const workerId = this.assignments.get(agentId);
    if (!workerId) return;
    const node = this.workers.get(workerId);
    if (node) {
      try {
        await node.stopAgent(agentId);
      } catch (error) {
        this.logger.warn?.(`[a8s] stopAgent failed on worker ${workerId}:`, error);
      }
    }
    this.assignments.delete(agentId);
  }

  /**
   * Move an agent from its current worker to a new one. Inherits the
   * current worker's machine label as `preferredMachine` by default so
   * a migrate that doesn't explicitly cross machines stays local (zero
   * data movement under the machine-scoped agentsRoot layout). Pass
   * `preferredMachine: null` to opt out, or `preferredMachine: '<id>'`
   * to force a different machine.
   */
  async migrateAgent(
    agentId: string,
    spec: WorkerAgentSpec,
    entry: TEntry,
    options: { hooks?: WorkerRuntimeHooks; preferredMachine?: string | null } = {},
  ): Promise<CreateAgentResult> {
    let preferred: string | undefined;
    if (options.preferredMachine === null) {
      preferred = undefined;
    } else if (options.preferredMachine !== undefined) {
      preferred = options.preferredMachine;
    } else {
      const currentWorkerId = this.assignments.get(agentId);
      const currentNode = currentWorkerId ? this.workers.get(currentWorkerId) : undefined;
      preferred = currentNode?.labels?.machine;
    }
    await this.deleteAgent(agentId);
    return this.createAgent(spec, entry, { hooks: options.hooks, preferredMachine: preferred });
  }

  /**
   * Open a data-plane handle for an agent. Throws when the agent is not
   * assigned in this ControlPlane, when the owning worker is unknown, or
   * when the worker reports no live mount (e.g. crashed mid-runAgent).
   */
  async openAgent(agentId: string): Promise<AgentSession> {
    const workerId = this.assignments.get(agentId);
    if (!workerId) {
      throw new Error(`Agent "${agentId}" is not assigned to any worker`);
    }
    const node = this.workers.get(workerId);
    if (!node) {
      throw new Error(`Worker "${workerId}" owning agent "${agentId}" is not registered`);
    }
    const session = await node.openSession(agentId);
    if (!session) {
      throw new Error(`Worker "${workerId}" has no live mount for agent "${agentId}"`);
    }
    return session;
  }

  getAgentLocation(agentId: string): AgentLocation {
    return { agentId, workerId: this.assignments.get(agentId) ?? null };
  }

  listAgents(): AgentLocation[] {
    return [...this.assignments.entries()].map(([agentId, workerId]) => ({
      agentId,
      workerId,
    }));
  }

  /**
   * Rebuild the in-memory `assignments` map from the orchestrator's active
   * leases. Run on startup before serving traffic so getAgentLocation /
   * openAgent / listAgents see the durable truth instead of an empty cache
   * left behind by a process crash.
   *
   * Leases whose `workerId` is missing or not registered with this plane
   * are returned as `unowned` — typically because the original worker
   * hasn't reconnected yet. They stay in the orchestrator's store and will
   * be reconciled the next time their worker re-registers and calls
   * hydrateAssignments() again.
   */
  async hydrateAssignments(): Promise<HydrateAssignmentsResult> {
    const leases = await this.orchestrator.listLeases();
    const restored: AgentLocation[] = [];
    const unowned: Array<{ agentId: string; workerId: string }> = [];
    for (const lease of leases) {
      if (lease.state !== 'active') continue;
      if (!lease.workerId) continue;
      if (this.workers.has(lease.workerId)) {
        this.assignments.set(lease.agentId, lease.workerId);
        restored.push({ agentId: lease.agentId, workerId: lease.workerId });
      } else {
        unowned.push({ agentId: lease.agentId, workerId: lease.workerId });
      }
    }
    return { restored, unowned };
  }

  /**
   * Schedule a wake for an agent. Wakes are durable in the orchestrator
   * store; any worker / control-plane process can claim them later.
   */
  scheduleWake(input: ScheduleRuntimeWakeInput): Promise<RuntimeWake> {
    return this.orchestrator.scheduleWake(input);
  }

  /** Sweep stale workers and surface evicted leases / workers to the caller. */
  async sweepStaleWorkers(): Promise<string[]> {
    const result = await this.orchestrator.evictStaleWorkers();
    const evictedIds = result.evicted.map((w) => w.workerId);
    for (const lease of result.releasedLeases) {
      const owner = this.assignments.get(lease.agentId);
      if (owner && evictedIds.includes(owner)) {
        this.assignments.delete(lease.agentId);
      }
    }
    return evictedIds;
  }

  /** Combined view of every worker's capacity. */
  async capacityReport(): Promise<Array<{ workerId: string; capacity: WorkerNodeCapacity }>> {
    const views = await this.gatherWorkerViews();
    return views.map(({ node, capacity }) => ({ workerId: node.workerId, capacity }));
  }

  private async gatherWorkerViews(): Promise<SchedulerWorkerView<TEntry>[]> {
    const result: SchedulerWorkerView<TEntry>[] = [];
    for (const node of this.workers.values()) {
      const capacity = await node.capacity();
      result.push({ node, capacity });
    }
    return result;
  }
}
