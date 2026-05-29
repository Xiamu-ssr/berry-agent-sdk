// ============================================================
// @berry-agent/machine-connector — HTTP daemon
// ============================================================
// The machine-side server a8s calls back to run commands. Minimal by
// design: /health (unauthenticated) + /exec (machine-token auth). The
// command runs through a CommandExecutor — NodeExecutor by default,
// which is correct *here* because this process literally is the target
// machine (unlike the brain side, where a silent local executor would be
// the wrong host — see M1's requireExecutor guard).
//
// spawn()/streaming and MCP proxying are deliberately out of scope for
// this file; they arrive with M6.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import {
  MACHINE_PATHS,
  WORKER_AUTH_HEADER,
  errorPayloadSchema,
  healthResponseSchema,
  machineExecReplySchema,
  machineExecRequestSchema,
  parseWorkerAuthHeader,
  type HealthResponse,
} from '@berry-agent/cluster-protocol';
import type { CommandExecutor } from '@berry-agent/core';
import { NodeExecutor } from '@berry-agent/tools-common';

export interface MachineConnectorDaemonOptions {
  machineId: string;
  port: number;
  /** Hostname/IP advertised to a8s (defaults to os.hostname). */
  bindHost?: string;
  /** Token a8s presents on /exec. Set via setAuthToken after register. */
  authToken?: string;
  /**
   * Executor that actually runs commands on this host. Defaults to
   * NodeExecutor. Inject a SandboxedExecutor to confine what the cluster
   * can do on this machine (recommended for anything but a throwaway box).
   */
  executor?: CommandExecutor;
  /** Default cwd when an exec request omits one. Defaults to process.cwd(). */
  defaultCwd?: string;
  version?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class MachineConnectorDaemon {
  private server: Server | null = null;
  private readonly options: MachineConnectorDaemonOptions;
  private readonly executor: CommandExecutor;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private authToken: string;
  private readonly startedAt = Date.now();

  constructor(options: MachineConnectorDaemonOptions) {
    this.options = options;
    this.executor = options.executor ?? new NodeExecutor();
    this.logger = options.logger ?? console;
    this.authToken = options.authToken ?? '';
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  async start(): Promise<{ host: string; port: number; callbackUrl: string }> {
    const bindHost = this.options.bindHost ?? hostname();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error?.('[machine-connector] unhandled error:', error);
        if (!res.headersSent) {
          writeJson(res, 500, errorPayloadSchema.parse({
            error: { code: 'internal_error', message: errorMessage(error) },
          }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const callbackUrl = `http://${bindHost}:${this.options.port}`;
    this.logger.log?.(`[machine-connector] listening on ${callbackUrl}`);
    return { host: bindHost, port: this.options.port, callbackUrl };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url === MACHINE_PATHS.health) {
      return writeJson(res, 200, this.healthPayload());
    }

    // Everything else needs the machine token a8s received at registration.
    if (this.authToken) {
      const presented = parseWorkerAuthHeader(
        req.headers[WORKER_AUTH_HEADER.toLowerCase()] as string | undefined,
      );
      if (presented !== this.authToken) {
        return writeJson(res, 401, errorPayloadSchema.parse({
          error: { code: 'unauthorized', message: 'invalid machine token' },
        }));
      }
    }

    if (req.method === 'POST' && url === MACHINE_PATHS.exec) {
      return this.handleExec(req, res);
    }

    return writeJson(res, 404, errorPayloadSchema.parse({
      error: { code: 'not_found', message: `no route for ${req.method} ${url}` },
    }));
  }

  private healthPayload(): HealthResponse {
    return healthResponseSchema.parse({
      ok: true,
      version: this.options.version ?? '0.0.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    });
  }

  private async handleExec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = machineExecRequestSchema.parse(await readJson(req));
    const result = await this.executor.exec(parsed.command, {
      cwd: parsed.cwd || this.options.defaultCwd || process.cwd(),
      timeout: parsed.timeoutMs,
      maxBuffer: parsed.maxBuffer,
      env: parsed.env,
    });
    writeJson(res, 200, machineExecReplySchema.parse({
      output: result.output,
      isError: result.isError,
    }));
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    req.on('data', (chunk) => { buffer += chunk; });
    req.on('end', () => {
      if (!buffer) { resolve({}); return; }
      try { resolve(JSON.parse(buffer)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
