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
// In-process workers wrap a single @berry-agent/worker Worker.

import type { Worker, WorkerAgentSpec, WorkerRuntimeHooks } from '@berry-agent/worker';
import type { ManagedAgentRuntime } from '@berry-agent/core';

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
  /** Optional runtime accessor for tests / tightly-coupled hosts. */
  getRuntime?(agentId: string): ManagedAgentRuntime | undefined;
}

/**
 * Wrap a local @berry-agent/worker Worker so the ControlPlane can drive it
 * through the WorkerNode contract.
 */
export class InProcessWorkerNode<TEntry = unknown> implements WorkerNode<TEntry> {
  constructor(
    public readonly workerId: string,
    private readonly worker: Worker<TEntry>,
    public readonly labels?: Readonly<Record<string, string>>,
  ) {}

  async capacity(): Promise<WorkerNodeCapacity> {
    // In-process workers without supervisor mode have no declared total.
    // Use a sensible large default so the scheduler treats them as
    // always-available; configure a real capacity by passing supervisor.worker
    // when constructing the underlying Worker.
    const w = this.worker.worker();
    const used = this.worker.ids().length;
    return {
      used,
      total: w?.capacity ?? Number.POSITIVE_INFINITY,
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

  getRuntime(agentId: string): ManagedAgentRuntime | undefined {
    return this.worker.get(agentId)?.runtime;
  }
}
