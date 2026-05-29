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
import { WorkerDaemon, WorkerRegistrationClient, withTeamModeHostTools } from './index.js';

const USAGE = `berry-worker — Berry Agent worker daemon

Usage:
  berry-worker start --config <path>
  berry-worker --help

Options:
  --config <path>      Path to worker config JSON file. Required for "start".
  --port <n>           HTTP port to listen on (overrides config.port, default: 7100)
  --a8s <url>          a8s control plane URL (overrides config.a8s)
  --worker-id <id>     Stable worker id (overrides config.workerId, default: hostname)
  --data-root <path>   Root dir for worker-private data — observe.db, creds.json,
                       logs (overrides config.dataRoot,
                       default: /var/berry/workers/<workerId>)
  --agents-root <path> Root dir for agent homes (overrides config.agentsRoot,
                       default: /var/berry/agents). Lives at the *machine*
                       level so any worker on this host can pick up an agent
                       after a process crash without copying data.
  --machine <id>       Machine identifier stamped into the worker's labels
                       (overrides config.machine, default: os.hostname()).
                       The a8s scheduler uses it as a same-machine affinity
                       hint when rescheduling stranded agents.
  --admin-token <s>    Bootstrap secret presented to a8s on join. Overrides
                       config.adminToken; env BERRY_A8S_ADMIN_TOKEN.
  --version            Print version
  --help               Show this help

DIRECTORY CONVENTION (machine-scoped agent data):

  /var/berry/
    ├── workers/<workerId>/       ← worker-private (per-process)
    │   ├── observe.db
    │   └── creds.json
    └── agents/<agentId>/         ← machine-shared (this is the key:
        ├── agent.json              data follows the *machine*, not the
        ├── AGENTS.md               worker process)
        ├── MEMORY.md
        ├── .mcp.json
        └── sessions/<sessionId>/
            ├── messages.json
            └── events.jsonl

  Why split: when a worker process crashes (deploy, OOM, bug — the common
  case), systemd restarts it and a8s re-mounts the agents from the same
  /var/berry/agents/<id> directory. Zero data movement, zero RTO. If a
  *different* worker on the same machine takes over after lease expiry,
  the agent dir is right there for it too. Only true cross-machine
  failover (rare) requires real data movement.
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
   * Machine identifier stamped into the worker's labels under
   * `labels.machine`. Defaults to os.hostname(). The a8s scheduler
   * treats workers sharing a machine value as failover-affinity peers —
   * an agent stranded by a crashed worker is preferentially re-mounted
   * on another worker on the same host, where its on-disk data already
   * lives.
   */
  machine: z.string().min(1).optional(),
  /**
   * Root directory for worker-private data — observe.db, credentials,
   * logs. Defaults to /var/berry/workers/<workerId>. Does NOT contain
   * agent homes (see agentsRoot).
   */
  dataRoot: z.string().min(1).optional(),
  /**
   * Root directory for agent homes, machine-scoped. Defaults to
   * /var/berry/agents. Each agent gets a subdir <agentsRoot>/<agentId>/
   * containing agent.json, AGENTS.md, MEMORY.md, sessions/, etc. Shared
   * across all workers on the same machine so a worker process crash is
   * transparent — restart the daemon, re-mount the same dir, no data
   * movement.
   */
  agentsRoot: z.string().min(1).optional(),
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
      'agents-root': { type: 'string' },
      machine: { type: 'string' },
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

  // ---- Resolve paths ----
  // Worker-private state (per-process, can be wiped on reinstall).
  const dataRoot = values['data-root'] ?? config.dataRoot ?? `/var/berry/workers/${workerId}`;
  // Agent homes (machine-scoped, survives worker restarts and is shared
  // across workers on the same machine for in-place failover).
  const agentsRoot = values['agents-root'] ?? config.agentsRoot ?? '/var/berry/agents';
  const credentialsPath = config.credentialsPath ?? join(dataRoot, 'creds.json');
  const observerDbPath = config.observerDbPath ?? join(dataRoot, 'observe.db');

  // Auto-create both roots so a fresh deploy just works. agentsRoot may
  // already exist (other worker on the same machine), which is exactly
  // the point — mkdir recursive is idempotent.
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(agentsRoot, { recursive: true });

  // ---- Assemble labels ----
  // The `machine` label is the affinity key the scheduler uses for
  // same-host failover; we always set it (default = hostname) so the
  // signal exists even when the operator didn't explicitly opt in.
  const machine = values.machine ?? config.machine ?? hostname();
  const labels: Record<string, string> = { ...(config.labels ?? {}), machine };

  // Resolve admin token early — needed by both registration (bootstrap
  // handshake) and team-mode (when the daemon mounts a teammate, the
  // injected message_leader tool calls a8s /v1/wakes/schedule which is
  // admin-scoped).
  const adminToken = values['admin-token'] ?? process.env.BERRY_A8S_ADMIN_TOKEN ?? config.adminToken;

  // ---- Build the WorkerEnvironment ----
  const env: WorkerEnvironment = {
    registry: config.registry as unknown as ModelsRegistry,
    credentials: new DefaultCredentialStore({ filePath: credentialsPath }),
    observer: createObserver({ dbPath: observerDbPath }),
  };

  // ---- Build the Worker ----
  const worker = new Worker({ env });

  // ---- Build the daemon ----
  // Base resolveSpec maps wire → full WorkerAgentSpec. We then wrap it
  // with the team-mode helper so agents arriving with labels.team='true'
  // get the message_leader hostTool auto-injected — but only when we
  // know how to authenticate against a8s for the wake schedule call.
  const baseResolveSpec = (wire: Parameters<NonNullable<ConstructorParameters<typeof WorkerDaemon>[0]['resolveSpec']>>[0]): WorkerAgentSpec => {
    const workspace = wire.workspace.includes('/') || wire.workspace.includes('\\')
      ? wire.workspace
      : join(agentsRoot, wire.workspace);
    return {
      agentId: wire.agentId,
      workspace,
      home: new AgentHome(workspace),
      projectRoot: wire.projectRoot,
      model: wire.model,
      ensureDefaultMcpConfig: wire.ensureDefaultMcpConfig,
    };
  };
  const resolveSpec = adminToken
    ? withTeamModeHostTools(baseResolveSpec, { a8sUrl, adminToken })
    : baseResolveSpec;

  const daemon = new WorkerDaemon({
    worker,
    workerId,
    port,
    bindHost: config.bindHost,
    version: '0.5.0-alpha.1',
    resolveSpec,
  });

  const info = await daemon.start();
  process.stdout.write(`🍓 berry-worker "${workerId}" listening on ${info.callbackUrl}\n`);
  process.stdout.write(`   machine: ${machine}\n`);
  process.stdout.write(`   data root: ${dataRoot}\n`);
  process.stdout.write(`   agents root: ${agentsRoot}\n`);

  // ---- Register with a8s ----
  const reg = new WorkerRegistrationClient({
    a8sUrl,
    workerId,
    callbackUrl: info.callbackUrl,
    capacity: config.capacity,
    heartbeatTtlMs: config.heartbeatTtlMs,
    labels,
    adminToken,
  });

  const regResult = await reg.register();
  daemon.setAuthToken(regResult.workerToken);
  process.stdout.write(`🔗 registered with a8s at ${a8sUrl}\n`);

  // ---- Auto-rehydrate owned agents from disk ----
  // The register response carries the agentIds that durable lease state
  // says this worker should own. Common case: a fresh join → empty.
  // Restart case (process crashed, systemd respawned us): the list
  // contains every agent we were running. For each one, read its
  // agent.json out of the machine-scoped agentsRoot and re-mount.
  if (regResult.ownedAgents.length > 0) {
    process.stdout.write(`🧬 rehydrating ${regResult.ownedAgents.length} agent(s) from disk...\n`);
    for (const agentId of regResult.ownedAgents) {
      try {
        const spec = await loadAgentSpecFromDisk(agentId, agentsRoot);
        if (worker.supervisor()) {
          await worker.runAgent(agentId, {}, spec);
        } else {
          worker.runAgentSync(agentId, {}, spec);
        }
        process.stdout.write(`   ✓ ${agentId}\n`);
      } catch (err) {
        process.stderr.write(
          `   ✗ ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

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

/**
 * Re-build a WorkerAgentSpec from on-disk state. Used during the
 * post-registration rehydrate loop to bring back agents that the
 * orchestrator says we still own after a worker process restart.
 *
 * `agent.json` is authoritative for model selection + reasoning effort;
 * everything else (projectRoot, ensureDefaultMcpConfig) is intentionally
 * minimal — the SDK rebuilds the rest from the on-disk home (sessions/,
 * skills/, .mcp.json). `projectRoot` is left undefined because nothing
 * persists it; agents that need it must be re-created through the full
 * a8s createAgent path.
 */
async function loadAgentSpecFromDisk(agentId: string, agentsRoot: string): Promise<WorkerAgentSpec> {
  const workspace = join(agentsRoot, agentId);
  const home = new AgentHome(workspace);
  const raw = await import('node:fs/promises').then((m) => m.readFile(home.metadataPath, 'utf-8'));
  const meta = JSON.parse(raw) as { id?: string; model?: string };
  if (!meta.model) {
    throw new Error(`agent.json at ${home.metadataPath} has no "model" — cannot rehydrate`);
  }
  return {
    agentId,
    workspace,
    home,
    model: meta.model,
    ensureDefaultMcpConfig: false,
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[berry-worker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
