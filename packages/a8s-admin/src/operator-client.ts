// ============================================================
// @berry-agent/a8s-admin — A8sOperatorClient
// ============================================================
// Thin HTTP client over the /v1/operator/* endpoints exposed by
// @berry-agent/a8s-server. Used by the cluster-admin Hand (this package)
// and by any other caller that wants to drive a8s programmatically —
// CLI tooling, monitoring scrapers, or future automation scripts.
//
// The client is auth-aware (admin token required for every call) and
// parses every response through the cluster-protocol zod schemas, so a
// drifted server immediately surfaces as a schema error instead of a
// silently-typed `any`.

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  createAgentRequestSchema,
  createAgentResponseSchema,
  listAgentsResponseSchema,
  operatorClusterReportSchema,
  operatorJoinScriptRequestSchema,
  operatorJoinScriptResponseSchema,
  operatorLeaseListResponseSchema,
  operatorOkResponseSchema,
  operatorWorkerListResponseSchema,
  sendRequestSchema,
  sendResponseSchema,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type OperatorClusterReport,
  type OperatorJoinScriptRequest,
  type OperatorJoinScriptResponse,
  type OperatorLeaseListResponse,
  type OperatorWorkerListResponse,
  type SendRequest,
  type SendResponse,
} from '@berry-agent/cluster-protocol';

export interface A8sOperatorClientOptions {
  /** Base URL of a8s, e.g. http://localhost:8080 or https://a8s.example.com */
  a8sUrl: string;
  /** Admin token; must match what a8s was started with. */
  adminToken: string;
  /** Optional fetch override for tests. */
  fetch?: typeof fetch;
}

export class A8sOperatorClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: A8sOperatorClientOptions) {
    this.baseUrl = options.a8sUrl.replace(/\/$/, '');
    this.token = options.adminToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  // ----- Cluster overview -----

  async clusterReport(): Promise<OperatorClusterReport> {
    return this.parseGet(A8S_PATHS.operatorCluster, operatorClusterReportSchema);
  }

  // ----- Workers -----

  async listWorkers(): Promise<OperatorWorkerListResponse> {
    return this.parseGet(A8S_PATHS.operatorWorkers, operatorWorkerListResponseSchema);
  }

  async drainWorker(workerId: string): Promise<void> {
    await this.parsePost(A8S_PATHS.operatorWorkerDrain(workerId), operatorOkResponseSchema);
  }

  async undrainWorker(workerId: string): Promise<void> {
    await this.parsePost(A8S_PATHS.operatorWorkerUndrain(workerId), operatorOkResponseSchema);
  }

  async evictWorker(workerId: string): Promise<void> {
    await this.parsePost(A8S_PATHS.operatorWorkerEvict(workerId), operatorOkResponseSchema);
  }

  // ----- Leases / agents -----

  async listLeases(): Promise<OperatorLeaseListResponse> {
    return this.parseGet(A8S_PATHS.operatorLeases, operatorLeaseListResponseSchema);
  }

  async listAgents(): Promise<ListAgentsResponse> {
    return this.parseGet(A8S_PATHS.agents, listAgentsResponseSchema);
  }

  // ----- Worker join script -----

  async joinScript(input: OperatorJoinScriptRequest = {}): Promise<OperatorJoinScriptResponse> {
    const body = JSON.stringify(operatorJoinScriptRequestSchema.parse(input));
    const resp = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.operatorWorkerJoinScript}`, {
      method: 'POST',
      headers: {
        [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
        'content-type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST join-script failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return operatorJoinScriptResponseSchema.parse(await resp.json());
  }

  // ----- Agent lifecycle / data plane (admin-scope) -----

  /** Create a cluster agent. a8s scheduler picks the worker. */
  async createAgent(input: CreateAgentRequest): Promise<CreateAgentResponse> {
    const body = JSON.stringify(createAgentRequestSchema.parse(input));
    const resp = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.agents}`, {
      method: 'POST',
      headers: {
        [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
        'content-type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST createAgent failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return createAgentResponseSchema.parse(await resp.json());
  }

  /** Send a turn to a cluster agent and await its full turn result. */
  async sendToAgent(agentId: string, input: SendRequest): Promise<SendResponse> {
    const body = JSON.stringify(sendRequestSchema.parse(input));
    const resp = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.agentSend(agentId)}`, {
      method: 'POST',
      headers: {
        [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
        'content-type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST send failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return sendResponseSchema.parse(await resp.json());
  }

  // ----- Internal HTTP helpers -----

  private async parseGet<T>(path: string, schema: { parse: (x: unknown) => T }): Promise<T> {
    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token) },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s GET ${path} failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return schema.parse(await resp.json());
  }

  private async parsePost<T>(path: string, schema: { parse: (x: unknown) => T }): Promise<T> {
    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST ${path} failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return schema.parse(await resp.json());
  }
}
