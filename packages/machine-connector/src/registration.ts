// ============================================================
// @berry-agent/machine-connector — Registration client
// ============================================================
// Wraps the a8s /machines/register + /machines/:id/heartbeat calls.
// Same shape as the worker daemon's registration client (deliberately —
// a machine registers like a worker), minus capacity/mountedAgents which
// a machine has no concept of. Holds the machine token and runs the
// heartbeat loop; re-registers on 401/404/410 so a control-plane restart
// re-discovers the machine without operator action.

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  machineHeartbeatRequestSchema,
  machineHeartbeatResponseSchema,
  machineRegistrationRequestSchema,
  machineRegistrationResponseSchema,
  machineWithdrawRequestSchema,
  workerAuthHeader,
  type MachineMcpManifest,
  type MachineRegistrationRequest,
  type MachineRegistrationResponse,
} from '@berry-agent/cluster-protocol';

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const t = timer as unknown as { unref?: () => void };
  if (t && typeof t.unref === 'function') t.unref();
}

export interface MachineRegistrationClientOptions {
  /** a8s base URL, e.g. http://control-plane.example.com:8080 */
  a8sUrl: string;
  machineId: string;
  callbackUrl: string;
  heartbeatTtlMs: number;
  platform?: MachineRegistrationRequest['platform'];
  labels?: Readonly<Record<string, string>>;
  /** Local MCP server ids this connector can proxy (M6). */
  mcpServers?: string[];
  /** Full MCP tool manifest the connector reports at registration (M6). */
  mcpManifest?: MachineMcpManifest;
  /** How often to heartbeat. Defaults to TTL/3. */
  heartbeatIntervalMs?: number;
  /** Bootstrap secret (a8s --admin-token). After register, switches to machine token. */
  adminToken?: string;
  /** Test injection. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class MachineRegistrationClient {
  private readonly options: MachineRegistrationClientOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private token: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MachineRegistrationClientOptions) {
    this.options = options;
    this.baseUrl = options.a8sUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? console;
  }

  async register(): Promise<MachineRegistrationResponse> {
    const body = machineRegistrationRequestSchema.parse({
      machineId: this.options.machineId,
      callbackUrl: this.options.callbackUrl,
      heartbeatTtlMs: this.options.heartbeatTtlMs,
      platform: this.options.platform,
      labels: this.options.labels,
      mcpServers: this.options.mcpServers ?? [],
      mcpManifest: this.options.mcpManifest,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.adminToken) {
      headers[ADMIN_AUTH_HEADER] = adminAuthHeader(this.options.adminToken);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.machinesRegister}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`machine registration failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const parsed = machineRegistrationResponseSchema.parse(await response.json());
    this.token = parsed.machineToken;
    this.startHeartbeatLoop();
    this.logger.log?.(`[machine-connector] registered with a8s as ${parsed.machineId}`);
    return parsed;
  }

  async withdraw(): Promise<void> {
    if (!this.token) return;
    this.stopHeartbeatLoop();
    const body = machineWithdrawRequestSchema.parse({});
    await this.fetchImpl(
      `${this.baseUrl}${A8S_PATHS.machineWithdraw(this.options.machineId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ADMIN_AUTH_HEADER]: workerAuthHeader(this.token),
        },
        body: JSON.stringify(body),
      },
    ).catch((err) => {
      this.logger.warn?.('[machine-connector] withdraw call failed:', err);
    });
    this.token = null;
  }

  getToken(): string | null {
    return this.token;
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.token) return;
    const body = machineHeartbeatRequestSchema.parse({});
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${A8S_PATHS.machineHeartbeat(this.options.machineId)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [ADMIN_AUTH_HEADER]: workerAuthHeader(this.token),
          },
          body: JSON.stringify(body),
        },
      );
      if (response.status === 401 || response.status === 404 || response.status === 410) {
        // a8s lost its machine table (restart / fresh control plane).
        // Re-register so the machine reappears with no operator action.
        this.logger.warn?.(
          `[machine-connector] heartbeat got HTTP ${response.status}; re-registering to converge`,
        );
        try { await this.register(); } catch (err) {
          this.logger.warn?.('[machine-connector] re-register failed:', err);
        }
        return;
      }
      if (!response.ok) {
        this.logger.warn?.(`[machine-connector] heartbeat HTTP ${response.status}`);
        return;
      }
      machineHeartbeatResponseSchema.parse(await response.json());
    } catch (err) {
      this.logger.warn?.('[machine-connector] heartbeat error:', err);
    }
  }

  private startHeartbeatLoop(): void {
    const interval = this.options.heartbeatIntervalMs
      ?? Math.max(1000, Math.floor(this.options.heartbeatTtlMs / 3));
    this.stopHeartbeatLoop();
    this.heartbeatTimer = setInterval(() => { void this.heartbeatOnce(); }, interval);
    unrefTimer(this.heartbeatTimer);
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
