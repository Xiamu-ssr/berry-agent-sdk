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
  operatorMachineJoinScriptRequestSchema,
  operatorMachineJoinScriptResponseSchema,
  operatorMachineListResponseSchema,
  operatorOkResponseSchema,
  operatorWorkerListResponseSchema,
  machineExecReplySchema,
  machineExecRequestSchema,
  machineMcpInvokeReplySchema,
  machineMcpInvokeRequestSchema,
  machineMcpManifestSchema,
  sendRequestSchema,
  sendResponseSchema,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type MachineExecReply,
  type MachineExecRequest,
  type MachineMcpInvokeReply,
  type MachineMcpInvokeRequest,
  type MachineMcpManifest,
  type OperatorClusterReport,
  type OperatorJoinScriptRequest,
  type OperatorJoinScriptResponse,
  type OperatorLeaseListResponse,
  type OperatorMachineJoinScriptRequest,
  type OperatorMachineJoinScriptResponse,
  type OperatorMachineListResponse,
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

  // ----- Machines (machine layer) -----

  async listMachines(): Promise<OperatorMachineListResponse> {
    return this.parseGet(A8S_PATHS.operatorMachines, operatorMachineListResponseSchema);
  }

  /** Generate the connector install snippet for a new machine. */
  async machineJoinScript(
    input: OperatorMachineJoinScriptRequest = {},
  ): Promise<OperatorMachineJoinScriptResponse> {
    const body = JSON.stringify(operatorMachineJoinScriptRequestSchema.parse(input));
    const resp = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.operatorMachineJoinScript}`, {
      method: 'POST',
      headers: {
        [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
        'content-type': 'application/json',
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST machine join-script failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return operatorMachineJoinScriptResponseSchema.parse(await resp.json());
  }

  /**
   * Run a command on a registered machine, brokered by a8s. The caller
   * authenticates with the admin token; a8s holds the machine token and
   * forwards. Returns the machine's exec reply.
   */
  async machineExec(machineId: string, input: MachineExecRequest): Promise<MachineExecReply> {
    const body = JSON.stringify(machineExecRequestSchema.parse(input));
    const resp = await this.fetchImpl(
      `${this.baseUrl}/v1/machines/${encodeURIComponent(machineId)}/exec`,
      {
        method: 'POST',
        headers: {
          [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
          'content-type': 'application/json',
        },
        body,
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST machine exec failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return machineExecReplySchema.parse(await resp.json());
  }

  /**
   * Invoke an MCP tool on a registered machine, brokered by a8s. Same
   * trust model as machineExec — a8s holds the machine token and forwards
   * to the connector, which holds the persistent stdio MCP connection.
   */
  async machineMcpInvoke(
    machineId: string,
    input: MachineMcpInvokeRequest,
  ): Promise<MachineMcpInvokeReply> {
    const body = JSON.stringify(machineMcpInvokeRequestSchema.parse(input));
    const resp = await this.fetchImpl(
      `${this.baseUrl}/v1/machines/${encodeURIComponent(machineId)}/mcp/invoke`,
      {
        method: 'POST',
        headers: {
          [ADMIN_AUTH_HEADER]: adminAuthHeader(this.token),
          'content-type': 'application/json',
        },
        body,
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s POST machine mcp invoke failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return machineMcpInvokeReplySchema.parse(await resp.json());
  }

  /**
   * Fetch a machine's MCP tool manifest so the brain can project each
   * tool into a model-visible tool. Returns the flat tool list a8s stored
   * verbatim at the connector's registration.
   */
  async machineMcpManifest(machineId: string): Promise<MachineMcpManifest> {
    return this.parseGet(
      `/v1/machines/${encodeURIComponent(machineId)}/mcp/manifest`,
      machineMcpManifestSchema,
    );
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
