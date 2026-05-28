#!/usr/bin/env node
// ============================================================
// @berry-agent/worker-daemon — CLI entry
// ============================================================
// Standalone binary that starts a worker HTTP daemon and registers
// it with an a8s control plane.
//
// Usage:
//   berry-worker start --config /etc/berry/worker.json
//   berry-worker --help
//
// The config file is required because a worker needs a `WorkerEnvironment`
// (provider registry + credential store path + observer settings) that
// can't be expressed as flat CLI flags. See berry-worker-config.example.json
// in this package's docs/ for the schema.

import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentHome, DefaultCredentialStore } from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import { createObserver } from '@berry-agent/observe';
import { Worker, type WorkerAgentSpec, type WorkerEnvironment } from '@berry-agent/worker';
import { WorkerDaemon, WorkerRegistrationClient } from './index.js';

const USAGE = `berry-worker — Berry Agent worker daemon

Usage:
  berry-worker start --config <path>
  berry-worker --help

Options:
  --config <path>     Path to worker config JSON file. Required for "start".
  --port <n>          HTTP port to listen on (overrides config.port, default: 7100)
  --a8s <url>         a8s control plane URL (overrides config.a8s)
  --worker-id <id>    Stable worker id (overrides config.workerId, default: hostname)
  --data-root <path>  Root dir for worker data (overrides config.dataRoot,
                      default: /var/berry/workers/<workerId>)
  --admin-token <s>   Bootstrap secret presented to a8s on join. Overrides
                      config.adminToken; env BERRY_A8S_ADMIN_TOKEN.
  --version           Print version
  --help              Show this help

DIRECTORY CONVENTION:
  Worker stores all its data under dataRoot:
    <dataRoot>/
      ├── observe.db    ← worker's observe SQLite
      ├── creds.json    ← credential store
      └── agents/       ← agent home root (each agent gets its own subdir)
          └── <agentId>/{agent.json, AGENTS.md, MEMORY.md, sessions/, ...}

  Default dataRoot is /var/berry/workers/<workerId>.
  Specify credentialsPath / observerDbPath in config only if you want to
  override individual paths (they default to <dataRoot>/creds.json and
  <dataRoot>/observe.db).
`;

const configSchema = z.object({
  /** Stable worker id; survives restarts. Defaults to os.hostname() at CLI start. */
  workerId: z.string().min(1).optional(),
  /** HTTP port the daemon listens on. */
  port: z.number().int().positive(),
  /** Hostname/IP the daemon advertises to a8s. Defaults to os.hostname(). */
  bindHost: z.string().min(1).optional(),
  /** a8s control plane base URL. */
  a8s: z.string().url(),
  /**
   * Bootstrap secret for the join handshake — same value the a8s
   * operator set with --admin-token. Overridable via --admin-token or
   * BERRY_A8S_ADMIN_TOKEN. Optional only because a8s may run in dev
   * mode without auth; required for any production deployment.
   */
  adminToken: z.string().min(1).optional(),
  /** Worker capacity. */
  capacity: z.number().int().nonnegative(),
  /** Heartbeat TTL in milliseconds. */
  heartbeatTtlMs: z.number().int().positive().default(30_000),
  /** Optional labels for affinity scheduling. */
  labels: z.record(z.string()).optional(),
  /**
   * Root directory for all worker data. Defaults to
   * /var/berry/workers/<workerId>. The worker auto-creates this and the
   * subdirs (agents/, observe.db, creds.json) on first launch.
   */
  dataRoot: z.string().min(1).optional(),
  /** Override credentials path (default: <dataRoot>/creds.json). */
  credentialsPath: z.string().min(1).optional(),
  /** Override observer db path (default: <dataRoot>/observe.db). */
  observerDbPath: z.string().min(1).optional(),
  /** Provider/model registry. Same shape as @berry-agent/models. */
  registry: z.object({
    providers: z.record(z.object({
      id: z.string(),
      presetId: z.string(),
      apiKey: z.string(),
      baseUrl: z.string().optional(),
    }).passthrough()),
    models: z.record(z.object({
      id: z.string(),
      contextWindow: z.number().optional(),
      providers: z.array(z.object({ providerId: z.string() }).passthrough()),
    }).passthrough()),
    tiers: z.record(z.string()),
  }).passthrough(),
}).strict();

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write('berry-worker 0.5.0-alpha.1\n');
    return 0;
  }

  const subcommand = argv[0];
  if (subcommand !== 'start') {
    process.stderr.write(`unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: 'string' },
      port: { type: 'string' },
      a8s: { type: 'string' },
      'worker-id': { type: 'string' },
      'data-root': { type: 'string' },
      'admin-token': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (!values.config) {
    process.stderr.write('--config is required for "start"\n\n');
    process.stderr.write(USAGE);
    return 2;
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(values.config, 'utf-8'));
  } catch (err) {
    process.stderr.write(`failed to read --config ${values.config}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const config = configSchema.parse(rawConfig);

  // CLI flags override config file
  const port = values.port ? parseInt(values.port, 10) : config.port;
  const a8sUrl = values.a8s ?? config.a8s;
  const workerId = values['worker-id'] ?? config.workerId ?? hostname();

  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`invalid port: ${port}\n`);
    return 2;
  }

  // ---- Resolve dataRoot + derived paths ----
  const dataRoot = values['data-root'] ?? config.dataRoot ?? `/var/berry/workers/${workerId}`;
  const agentsDir = join(dataRoot, 'agents');
  const credentialsPath = config.credentialsPath ?? join(dataRoot, 'creds.json');
  const observerDbPath = config.observerDbPath ?? join(dataRoot, 'observe.db');

  // Auto-create directory tree so a fresh deploy just works.
  mkdirSync(agentsDir, { recursive: true });

  // ---- Build the WorkerEnvironment ----
  const env: WorkerEnvironment = {
    registry: config.registry as unknown as ModelsRegistry,
    credentials: new DefaultCredentialStore({ filePath: credentialsPath }),
    observer: createObserver({ dbPath: observerDbPath }),
  };

  // ---- Build the Worker ----
  const worker = new Worker({ env });

  // ---- Build the daemon ----
  const daemon = new WorkerDaemon({
    worker,
    workerId,
    port,
    bindHost: config.bindHost,
    version: '0.5.0-alpha.1',
    /**
     * Resolve a wire spec into a full WorkerAgentSpec. The agent's
     * workspace is reinterpreted as relative to this worker's agentsDir
     * if it's a bare agent id (no path separator) — letting clients say
     * `workspace: "coder"` without knowing absolute paths on the worker.
     * Absolute paths are passed through verbatim for advanced setups.
     */
    resolveSpec: (wire): WorkerAgentSpec => {
      const workspace = wire.workspace.includes('/') || wire.workspace.includes('\\')
        ? wire.workspace
        : join(agentsDir, wire.workspace);
      return {
        agentId: wire.agentId,
        workspace,
        home: new AgentHome(workspace),
        projectRoot: wire.projectRoot,
        model: wire.model,
        ensureDefaultMcpConfig: wire.ensureDefaultMcpConfig,
      };
    },
  });

  const info = await daemon.start();
  process.stdout.write(`🍓 berry-worker "${workerId}" listening on ${info.callbackUrl}\n`);
  process.stdout.write(`   data root: ${dataRoot}\n`);

  // ---- Register with a8s ----
  const reg = new WorkerRegistrationClient({
    a8sUrl,
    workerId,
    callbackUrl: info.callbackUrl,
    capacity: config.capacity,
    heartbeatTtlMs: config.heartbeatTtlMs,
    labels: config.labels,
    adminToken: values['admin-token'] ?? process.env.BERRY_A8S_ADMIN_TOKEN ?? config.adminToken,
  });

  const regResult = await reg.register();
  daemon.setAuthToken(regResult.workerToken);
  process.stdout.write(`🔗 registered with a8s at ${a8sUrl}\n`);

  // ---- Graceful shutdown ----
  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[berry-worker] received ${signal}, draining...\n`);
    try {
      await reg.withdraw(true);
      await daemon.stop();
      await worker.dispose();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[berry-worker] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  await new Promise<void>(() => { /* never resolves */ });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[berry-worker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
