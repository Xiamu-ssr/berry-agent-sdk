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
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
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
  --version           Print version
  --help              Show this help
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
  /** Worker capacity. */
  capacity: z.number().int().nonnegative(),
  /** Heartbeat TTL in milliseconds. */
  heartbeatTtlMs: z.number().int().positive().default(30_000),
  /** Optional labels for affinity scheduling. */
  labels: z.record(z.string()).optional(),
  /** Where the worker stores its credential file. */
  credentialsPath: z.string().min(1),
  /** Observer SQLite path. Use ':memory:' for stateless workers. */
  observerDbPath: z.string().min(1),
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

  // ---- Build the WorkerEnvironment ----
  const env: WorkerEnvironment = {
    registry: config.registry as unknown as ModelsRegistry,
    credentials: new DefaultCredentialStore({ filePath: config.credentialsPath }),
    observer: createObserver({ dbPath: config.observerDbPath }),
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
     * Resolve a wire spec into a full WorkerAgentSpec. AgentHome is
     * constructed from the workspace path. Hosts that need fancier spec
     * resolution (host tools, project-specific config) should write a
     * custom daemon main instead of using this CLI.
     */
    resolveSpec: (wire): WorkerAgentSpec => ({
      agentId: wire.agentId,
      workspace: wire.workspace,
      home: new AgentHome(wire.workspace),
      projectRoot: wire.projectRoot,
      model: wire.model,
      ensureDefaultMcpConfig: wire.ensureDefaultMcpConfig,
    }),
  });

  const info = await daemon.start();
  process.stdout.write(`🍓 berry-worker "${workerId}" listening on ${info.callbackUrl}\n`);

  // ---- Register with a8s ----
  const reg = new WorkerRegistrationClient({
    a8sUrl,
    workerId,
    callbackUrl: info.callbackUrl,
    capacity: config.capacity,
    heartbeatTtlMs: config.heartbeatTtlMs,
    labels: config.labels,
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
