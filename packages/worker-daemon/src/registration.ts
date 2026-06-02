// ============================================================
// @berry-agent/worker-daemon — Registration client
// ============================================================
// Convenience wrapper around the a8s /workers/register +
// /workers/:id/heartbeat HTTP calls. Handles token storage and the
// periodic heartbeat loop so callers only need to wire start/stop.

import {
  A8S_PATHS,
  WORKER_AUTH_HEADER,
  adminAuthHeader,
  workerAuthHeader,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  workerRegistrationRequestSchema,
  workerRegistrationResponseSchema,
  workerWithdrawRequestSchema,
  type WorkerRegistrationResponse,
} from '@berry-agent/cluster-protocol';

function unrefTimerInline(timer: ReturnType<typeof setInterval>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = timer as any;
  if (t && typeof t.unref === 'function') t.unref();
}

export interface RegistrationClientOptions {
  /** a8s base URL, e.g. http://control-plane.example.com:8080 */
  a8sUrl: string;
  workerId: string;
  callbackUrl: string;
  capacity: number;
  heartbeatTtlMs: number;
  labels?: Readonly<Record<string, string>>;
  /** How often to send heartbeat. Defaults to TTL/3. */
  heartbeatIntervalMs?: number;
  /**
   * Bootstrap secret presented to a8s on /workers/register. Same value
   * the a8s operator passed to --admin-token. After registration the
   * worker switches to the per-worker token returned in the response.
   * When unset and a8s is in dev mode, registration still succeeds.
   */
  adminToken?: string;
  /**
   * Lazy provider for agents this worker has *already mounted* before
   * (re-)registering with a8s. Lets a8s converge on the worker's
   * authoritative in-memory state when its own lease table was lost
   * (e.g. a control-plane restart with a memory store) — the worker
   * process is the truth, a8s metadata is the index. Defaults to "no
   * mounted agents", which is correct on a fresh worker start.
   */
  mountedAgentsProvider?: () => string[];
  /** Test injection. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class WorkerRegistrationClient {
  private readonly options: RegistrationClientOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private token: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RegistrationClientOptions) {
    this.options = options;
    this.baseUrl = options.a8sUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? console;
  }

  /**
   * Register with a8s. Returns the issued token; caller should pass it to
   * the WorkerDaemon via setAuthToken so the daemon will accept a8s calls.
   */
  async register(): Promise<WorkerRegistrationResponse> {
    const mountedAgents = this.options.mountedAgentsProvider?.() ?? [];
    const body = workerRegistrationRequestSchema.parse({
      workerId: this.options.workerId,
      callbackUrl: this.options.callbackUrl,
      capacity: this.options.capacity,
      heartbeatTtlMs: this.options.heartbeatTtlMs,
      labels: this.options.labels,
      mountedAgents,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.adminToken) {
      headers[WORKER_AUTH_HEADER] = adminAuthHeader(this.options.adminToken);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${A8S_PATHS.workersRegister}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`worker registration failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const parsed = workerRegistrationResponseSchema.parse(await response.json());
    this.token = parsed.workerToken;
    this.startHeartbeatLoop();
    this.logger.log?.(`[worker-daemon] registered with a8s as ${parsed.workerId}`);
    return parsed;
  }

  async withdraw(drain = true): Promise<void> {
    if (!this.token) return;
    this.stopHeartbeatLoop();
    const body = workerWithdrawRequestSchema.parse({ drain });
    await this.fetchImpl(
      `${this.baseUrl}${A8S_PATHS.workerWithdraw(this.options.workerId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WORKER_AUTH_HEADER]: workerAuthHeader(this.token),
        },
        body: JSON.stringify(body),
      },
    ).catch((err) => {
      this.logger.warn?.('[worker-daemon] withdraw call failed:', err);
    });
    this.token = null;
  }

  getToken(): string | null {
    return this.token;
  }

  private async heartbeatOnce(): Promise<void> {
    if (!this.token) return;
    // Report mounted agents so a8s can renew their leases (only the holder
    // can renew) — keeps an idle agent's lease alive under a running worker.
    const mountedAgents = this.options.mountedAgentsProvider?.() ?? [];
    const body = workerHeartbeatRequestSchema.parse({ mountedAgents });
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${A8S_PATHS.workerHeartbeat(this.options.workerId)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKER_AUTH_HEADER]: workerAuthHeader(this.token),
          },
          body: JSON.stringify(body),
        },
      );
      if (response.status === 401 || response.status === 404 || response.status === 410) {
        // a8s no longer knows about us — its lease/worker table was lost
        // (restart with memory store, fresh control plane, evict, etc).
        // Re-register, which lets the worker self-report its current
        // mounts so a8s can converge on the truth.
        this.logger.warn?.(
          `[worker-daemon] heartbeat got HTTP ${response.status} from a8s; re-registering to converge`,
        );
        try {
          await this.register();
        } catch (err) {
          this.logger.warn?.('[worker-daemon] re-register failed:', err);
        }
        return;
      }
      if (!response.ok) {
        this.logger.warn?.(`[worker-daemon] heartbeat HTTP ${response.status}`);
        return;
      }
      workerHeartbeatResponseSchema.parse(await response.json());
    } catch (err) {
      this.logger.warn?.('[worker-daemon] heartbeat error:', err);
    }
  }

  private startHeartbeatLoop(): void {
    const interval = this.options.heartbeatIntervalMs ?? Math.max(1000, Math.floor(this.options.heartbeatTtlMs / 3));
    this.stopHeartbeatLoop();
    this.heartbeatTimer = setInterval(() => { void this.heartbeatOnce(); }, interval);
    unrefTimerInline(this.heartbeatTimer);
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
