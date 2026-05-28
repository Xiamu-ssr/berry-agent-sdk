// ============================================================
// @berry-agent/a8s — Worker Node abstraction
// ============================================================
// The ControlPlane talks to workers through a `WorkerNode` interface
// instead of grabbing a concrete Worker class. This lets:
//   - Tests mount in-process Worker instances directly
//   - M4 plug an HTTP/gRPC transport without touching ControlPlane code
//   - Future heterogeneous workers (container-only, GPU-only) advertise
//     different capabilities through the same shape
//
// In-process workers wrap a single @berry-agent/worker Worker and expose
// AgentSession handles for products to drive mounted agents.

import type { Worker, WorkerAgentSpec, WorkerRuntimeHooks } from '@berry-agent/worker';
import { InProcessAgentSession, type AgentSession } from './agent-session.js';

export interface WorkerNodeCapacity {
  used: number;
  total: number;
}

/**
 * Anything the ControlPlane needs to drive one worker. Implementations
 * may live in the same process (InProcessWorkerNode) or wrap a remote
 * transport (future).
 */
export interface WorkerNode<TEntry = unknown> {
  readonly workerId: string;
  readonly labels?: Readonly<Record<string, string>>;
  capacity(): Promise<WorkerNodeCapacity>;
  has(agentId: string): Promise<boolean>;
  runAgent(
    agentId: string,
    entry: TEntry,
    spec: WorkerAgentSpec,
    hooks?: WorkerRuntimeHooks,
  ): Promise<void>;
  stopAgent(agentId: string): Promise<void>;
  /**
   * Return an AgentSession handle for an agent currently mounted on this
   * worker, or `undefined` if the agent is not mounted here. The handle
   * is the only sanctioned data-plane surface — it isolates products from
   * `ManagedAgentRuntime` internals so M4 transport variants can swap in
   * without product-side changes.
   */
  openSession(agentId: string): Promise<AgentSession | undefined>;
}

export interface InProcessWorkerNodeOptions {
  /**
   * Total capacity advertised when the underlying Worker has no supervisor
   * (i.e. when there's no durable RuntimeWorker entry to read from).
   * Defaults to POSITIVE_INFINITY so unscheduled in-process workers are
   * treated as always-available — matches the previous behavior, but lets
   * tests and small deployments cap a worker without spinning up the
   * supervisor stack.
   */
  defaultCapacity?: number;
  labels?: Readonly<Record<string, string>>;
}

/**
 * Wrap a local @berry-agent/worker Worker so the ControlPlane can drive it
 * through the WorkerNode contract.
 */
export class InProcessWorkerNode<TEntry = unknown> implements WorkerNode<TEntry> {
  public readonly labels?: Readonly<Record<string, string>>;
  private readonly defaultCapacity: number;

  constructor(
    public readonly workerId: string,
    private readonly worker: Worker<TEntry>,
    options: InProcessWorkerNodeOptions = {},
  ) {
    this.labels = options.labels;
    this.defaultCapacity = options.defaultCapacity ?? Number.POSITIVE_INFINITY;
  }

  async capacity(): Promise<WorkerNodeCapacity> {
    // When the underlying Worker is in supervisor mode, it has a durable
    // RuntimeWorker entry whose capacity is the source of truth. Otherwise
    // fall back to the constructor-supplied defaultCapacity so tests and
    // single-process deployments can advertise a real cap without wiring up
    // the supervisor stack.
    const w = this.worker.worker();
    const used = this.worker.ids().length;
    return {
      used,
      total: w?.capacity ?? this.defaultCapacity,
    };
  }

  async has(agentId: string): Promise<boolean> {
    return this.worker.has(agentId);
  }

  async runAgent(
    agentId: string,
    entry: TEntry,
    spec: WorkerAgentSpec,
    hooks: WorkerRuntimeHooks = {},
  ): Promise<void> {
    if (this.worker.supervisor()) {
      await this.worker.runAgent(agentId, entry, spec, hooks);
    } else {
      this.worker.runAgentSync(agentId, entry, spec, hooks);
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.worker.stopAgent(agentId);
  }

  async openSession(agentId: string): Promise<AgentSession | undefined> {
    const mount = this.worker.get(agentId);
    if (!mount) return undefined;
    return new InProcessAgentSession(agentId, mount.runtime);
  }
}
