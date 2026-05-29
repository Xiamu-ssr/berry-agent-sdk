// ============================================================
// @berry-agent/a8s — HttpWorkerNode
// ============================================================
// WorkerNode implementation that drives a remote @berry-agent/worker-daemon
// over HTTP. The contract is identical to InProcessWorkerNode so the
// ControlPlane is transport-agnostic: swap an InProcessWorkerNode for an
// HttpWorkerNode and the scheduler / hydrateAssignments / openAgent logic
// is unchanged.
//
// What this class does NOT do:
//   - openSession() returns undefined. AgentSession over HTTP is a separate
//     concern — the a8s-server proxies session calls directly to the
//     owning worker via the wire protocol's /agents/:id/send endpoint.
//     A future RemoteAgentSession class will package that up; until then
//     openSession on a remote worker is intentionally a no-op so callers
//     fall back to the proxy path explicitly.

import {
  WORKER_PATHS,
  workerAuthHeader,
  workerCapacityResponseSchema,
  workerHasAgentResponseSchema,
  workerRunAgentRequestSchema,
  workerStopAgentResponseSchema,
  type WireAgentSpec,
} from '@berry-agent/cluster-protocol';
import type { WorkerRuntimeHooks } from '@berry-agent/worker';
import type { AgentSession } from './agent-session.js';
import type { WireWorkerAgentSpec, WorkerNode, WorkerNodeCapacity } from './worker-node.js';

export interface HttpWorkerNodeOptions {
  /** Stable worker id matching the one the daemon registered with. */
  workerId: string;
  /** Base URL of the worker daemon (e.g. http://10.0.1.5:7100). */
  callbackUrl: string;
  /** Bearer token issued at registration time. */
  workerToken: string;
  /** Optional labels mirrored from registration for scheduler hints. */
  labels?: Readonly<Record<string, string>>;
  /** Optional custom fetch (test injection). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 10s. */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpWorkerNode<TEntry = unknown> implements WorkerNode<TEntry> {
  readonly workerId: string;
  readonly labels?: Readonly<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpWorkerNodeOptions) {
    this.workerId = options.workerId;
    this.labels = options.labels;
    this.baseUrl = options.callbackUrl.replace(/\/$/, '');
    this.token = options.workerToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('HttpWorkerNode: no fetch implementation available');
    }
  }

  async capacity(): Promise<WorkerNodeCapacity> {
    const body = await this.json(WORKER_PATHS.capacity, 'GET', null, workerCapacityResponseSchema);
    return {
      used: body.used,
      total: body.total ?? Number.POSITIVE_INFINITY,
    };
  }

  async has(agentId: string): Promise<boolean> {
    const body = await this.json(WORKER_PATHS.hasAgent(agentId), 'GET', null, workerHasAgentResponseSchema);
    return body.has;
  }

  async runAgent(
    agentId: string,
    entry: TEntry,
    spec: WireWorkerAgentSpec,
    _hooks?: WorkerRuntimeHooks,
  ): Promise<void> {
    // Wire spec is already JSON-safe; just normalise the id slot and
    // forward. Worker daemon's resolveSpec re-hydrates AgentHome and
    // any host-specific extras on its side.
    const wireBody: WireAgentSpec = {
      agentId,
      workspace: spec.workspace,
      projectRoot: spec.projectRoot,
      model: spec.model,
      reasoningEffort: spec.reasoningEffort,
      toolDenylist: spec.toolDenylist,
      ensureDefaultMcpConfig: spec.ensureDefaultMcpConfig,
      labels: spec.labels,
    };
    const body = workerRunAgentRequestSchema.parse({
      spec: wireBody,
      entry: entry as Record<string, unknown> | undefined,
    });
    await this.json(WORKER_PATHS.runAgent(agentId), 'POST', body, workerStopAgentResponseSchema);
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.json(WORKER_PATHS.stopAgent(agentId), 'POST', null, workerStopAgentResponseSchema);
  }

  /**
   * Remote workers don't expose `AgentSession` directly through this node —
   * the a8s-server has its own proxy path for that (so a8s can short-circuit
   * directly to the worker rather than going through this node abstraction).
   * Callers fall back to the proxy path when this returns undefined.
   */
  async openSession(_agentId: string): Promise<AgentSession | undefined> {
    return undefined;
  }

  private async json<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    schema: { parse: (input: unknown) => T },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [WORKER_AUTH_HEADER_KEY]: workerAuthHeader(this.token),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`worker ${this.workerId} → ${path} failed: HTTP ${response.status}: ${raw.slice(0, 200)}`);
      }
      const parsed = raw.length > 0 ? JSON.parse(raw) : {};
      return schema.parse(parsed);
    } finally {
      clearTimeout(timer);
    }
  }
}

const WORKER_AUTH_HEADER_KEY = 'authorization' as const;
