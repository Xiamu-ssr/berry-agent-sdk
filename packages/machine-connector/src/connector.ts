// ============================================================
// @berry-agent/machine-connector — embeddable orchestration
// ============================================================
// One call that wires the three connector pieces together:
//   local MCP host (optional) → HTTP daemon → a8s registration.
//
// This is the seam that makes the connector "standalone AND embeddable":
//   - `berry-machine` (cli.ts) parses flags, calls this, installs signal
//     handlers, and blocks forever.
//   - A GUI client (the Mac app) bundles the connector by calling this on
//     launch and `handle.stop()` on quit — no need to re-implement the
//     start/register/withdraw dance.
//
// Signal handling and process lifetime are deliberately NOT here: an
// embedder owns its own lifecycle and would not want us trapping SIGINT.

import { existsSync } from 'node:fs';
import { hostname, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import type { CommandExecutor } from '@berry-agent/core';
import type { MachineRegistrationRequest } from '@berry-agent/cluster-protocol';
import { MachineConnectorDaemon } from './daemon.js';
import { MachineRegistrationClient } from './registration.js';
import { MachineMcpHost } from './mcp-host.js';

export type MachinePlatform = MachineRegistrationRequest['platform'];

export function detectPlatform(): MachinePlatform {
  switch (osPlatform()) {
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return 'other';
  }
}

export interface StartMachineConnectorOptions {
  /** a8s control plane base URL. Required. */
  a8sUrl: string;
  /** Stable machine id. Defaults to os.hostname(). */
  machineId?: string;
  /** HTTP port the daemon listens on. Default 7200. */
  port?: number;
  /** Hostname/IP advertised to a8s. Defaults to os.hostname(). */
  bindHost?: string;
  /** Bootstrap secret (a8s --admin-token); falls back to env BERRY_A8S_ADMIN_TOKEN. */
  adminToken?: string;
  /** Heartbeat TTL in ms. Default 30_000. */
  heartbeatTtlMs?: number;
  /** Labels advertised to a8s at registration. */
  labels?: Record<string, string>;
  /**
   * Path to a .mcp.json whose servers this machine proxies as Hands. When
   * omitted, `<cwd>/.mcp.json` is used if present; pass `null` to disable
   * MCP discovery entirely even when a .mcp.json exists.
   */
  mcpConfigPath?: string | null;
  /**
   * Executor that runs /exec commands on this host. Defaults to the
   * daemon's NodeExecutor. Inject a sandboxed executor to confine the
   * cluster's reach on this machine.
   */
  executor?: CommandExecutor;
  version?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** A live connector. Call `stop()` to withdraw from a8s and release the port. */
export interface RunningMachineConnector {
  machineId: string;
  callbackUrl: string;
  platform: MachinePlatform;
  /** Present only when a local MCP host was started. */
  mcp?: { servers: string[]; toolCount: number };
  /** Withdraw from a8s, stop the daemon, dispose the MCP host. Idempotent. */
  stop(): Promise<void>;
}

const DEFAULT_PORT = 7200;
const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

/**
 * Start a machine connector and register it with a8s. Resolves once the
 * daemon is listening and registration succeeded; the heartbeat loop runs
 * in the background until `stop()`.
 */
export async function startMachineConnector(
  options: StartMachineConnectorOptions,
): Promise<RunningMachineConnector> {
  const logger = options.logger ?? console;
  const machineId = options.machineId ?? hostname();
  const port = options.port ?? DEFAULT_PORT;
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const platform = detectPlatform();
  const adminToken = options.adminToken ?? process.env.BERRY_A8S_ADMIN_TOKEN;

  // ---- Local MCP (optional) ----
  // Default to <cwd>/.mcp.json when present; explicit path wins; null disables.
  const mcpConfigPath = options.mcpConfigPath === null
    ? undefined
    : options.mcpConfigPath
      ?? (existsSync(join(process.cwd(), '.mcp.json')) ? join(process.cwd(), '.mcp.json') : undefined);
  let mcpHost: MachineMcpHost | undefined;
  if (mcpConfigPath) {
    mcpHost = new MachineMcpHost({ configPath: mcpConfigPath });
    await mcpHost.start();
  }

  // Forward-declared so the daemon's onReload closure can reach it; assigned
  // just below once the daemon is listening (the closure only fires later).
  let reg: MachineRegistrationClient | undefined;
  const daemon = new MachineConnectorDaemon({
    machineId,
    port,
    bindHost: options.bindHost,
    version: options.version,
    executor: options.executor,
    mcpHost,
    logger,
    // After a /reload, push the rescanned capability to a8s so a remotely
    // provisioned Hand becomes visible cluster-wide on the next heartbeat.
    onReload: (servers) => {
      reg?.updateCapability(servers, mcpHost?.manifest() ?? { tools: [] });
    },
  });
  const info = await daemon.start();

  reg = new MachineRegistrationClient({
    a8sUrl: options.a8sUrl,
    machineId,
    callbackUrl: info.callbackUrl,
    heartbeatTtlMs,
    platform,
    labels: options.labels,
    adminToken,
    mcpServers: mcpHost?.serverIds(),
    mcpManifest: mcpHost?.manifest(),
    logger,
  });

  try {
    const result = await reg.register();
    daemon.setAuthToken(result.machineToken);
  } catch (err) {
    // Registration failed — don't leave the port bound or MCP sessions open.
    await daemon.stop().catch(() => {});
    await mcpHost?.dispose().catch(() => {});
    throw err;
  }

  let stopped = false;
  return {
    machineId,
    callbackUrl: info.callbackUrl,
    platform,
    mcp: mcpHost
      ? { servers: mcpHost.serverIds(), toolCount: mcpHost.manifest().tools.length }
      : undefined,
    async stop() {
      if (stopped) return;
      stopped = true;
      await reg.withdraw();
      await daemon.stop();
      await mcpHost?.dispose();
    },
  };
}
