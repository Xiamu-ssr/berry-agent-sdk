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
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  modelsTemplateGetResponseSchema,
} from '@berry-agent/cluster-protocol';
import { AgentHome, DefaultCredentialStore } from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import { createObserver } from '@berry-agent/observe';
import { Worker, type WorkerAgentSpec, type WorkerEnvironment } from '@berry-agent/worker';
import { WorkerDaemon, WorkerRegistrationClient, withTeamModeHostTools, withAdminOpsEnv, withMachineHostTools } from './index.js';
import { parseBuiltinHands, selectBuiltinHands } from './builtin-hands.js';

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

MODELS REGISTRY:
  worker.json may set "registry": null (or omit it) — the worker will
  then fetch the cluster-wide template from a8s at start (requires
  admin token). The recommended path: configure providers/tiers once
  in the a8s UI, leave every worker.json as "registry": null. Inline
  registries are still supported for air-gapped or pinned setups.

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
  /**
   * Provider/model registry. Same shape as @berry-agent/models. Set
   * `null` (or omit) to have the worker fetch the cluster-wide models
   * template from a8s at register time — the recommended path so
   * operators configure LLMs once in the UI and every worker
   * auto-inherits. Set inline for air-gapped / pinned setups.
   */
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
  }).passthrough().nullable().optional(),
}).strict();

/**
 * Fetch the cluster-wide models template from a8s. Returns a fully
 * inflated ModelsRegistry. Throws when a8s is unreachable, returns a
 * non-2xx, or returns a null template (operator hasn't configured one
 * yet — startup must fail loudly rather than silently spawn a worker
 * with no model).
 */
async function fetchModelsTemplate(a8sUrl: string, adminToken: string): Promise<ModelsRegistry> {
  const url = a8sUrl.replace(/\/$/, '') + A8S_PATHS.operatorModelsTemplate;
  const response = await fetch(url, {
    method: 'GET',
    headers: { [ADMIN_AUTH_HEADER]: adminAuthHeader(adminToken) },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`models template GET failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const parsed = modelsTemplateGetResponseSchema.parse(await response.json());
  if (!parsed.template) {
    throw new Error(
      'a8s has no models template configured yet. Open the a8s UI → Settings → Models, configure providers/tiers, then restart this worker.',
    );
  }
  return parsed.template as unknown as ModelsRegistry;
}

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

  // ---- Resolve models registry ----
  // Prefer inline `config.registry`; if null/missing, fetch the
  // cluster-wide template from a8s. This lets operators configure LLMs
  // once in the UI and have every new worker auto-inherit.
  let registry: ModelsRegistry;
  if (config.registry) {
    registry = config.registry as unknown as ModelsRegistry;
  } else {
    if (!adminToken) {
      process.stderr.write(
        'config.registry is null and no admin token available; cannot fetch models template from a8s\n',
      );
      return 2;
    }
    try {
      registry = await fetchModelsTemplate(a8sUrl, adminToken);
      process.stdout.write(`📦 pulled models template from a8s (${Object.keys(registry.providers ?? {}).length} providers, ${Object.keys(registry.models ?? {}).length} models)\n`);
    } catch (err) {
      process.stderr.write(`failed to fetch models template from a8s: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  // ---- Build the WorkerEnvironment ----
  const env: WorkerEnvironment = {
    registry,
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
    // Built-in Hand selection via labels.hands (comma list of: workspace, web).
    // Absent → both on (default). This keeps Hand assembly on one mechanism
    // (labels) shared with machines/team/role — products pick built-in Hands
    // the same way they pick a machine, no special wire field.
    const builtinHands = parseBuiltinHands(wire.labels?.hands);
    return {
      agentId: wire.agentId,
      workspace,
      home: new AgentHome(workspace),
      projectRoot: wire.projectRoot,
      model: wire.model,
      ensureDefaultMcpConfig: wire.ensureDefaultMcpConfig,
      ...(builtinHands.workspace === false ? { workspaceTools: false } : {}),
      ...(builtinHands.web === false ? { webTools: false } : {}),
    };
  };
  // Chain the resolveSpec wrappers. When admin token is configured we
  // layer team-mode (label-gated message_leader injection) and
  // admin-ops-mode (label-gated a8s credential injection for the
  // berry-admin agent's berry-a8s-ops CLI) on top of the base resolver.
  // Each wrapper inspects labels on its own and is a no-op for agents
  // that don't match.
  let resolveSpec = baseResolveSpec;
  if (adminToken) {
    resolveSpec = withTeamModeHostTools(resolveSpec, { a8sUrl, adminToken });
    resolveSpec = withAdminOpsEnv(resolveSpec, { a8sUrl, adminToken });
    resolveSpec = withMachineHostTools(resolveSpec, { a8sUrl, adminToken });
  }

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
    // a8s convergence hook: tell the control plane every agent we
    // currently have mounted (in case its lease table was wiped, e.g.
    // memory store + a8s restart). On a fresh worker start this is
    // empty; on a worker process restart this is the list we just
    // rehydrated from disk above.
    mountedAgentsProvider: () => worker.ids(),
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

  // ---- Recover agents whose lease expired before we restarted ----
  // a8s's ownedAgents only lists agents with a still-active lease. If a8s +
  // this worker were both down past the lease TTL, an idle agent's lease
  // expired and a8s no longer knows we own it — but its home is still on
  // disk. Scan agentsRoot and re-mount any agent.json-bearing dir we didn't
  // already rehydrate, then let the heartbeat self-report it: a8s reconciles
  // via acquireLease, which safely revives the expired lease (and fails if
  // another worker legitimately took over — so no double-mount). This closes
  // the restart-deadlock for idle agents.
  if (existsSync(agentsRoot)) {
    const alreadyMounted = new Set(worker.ids());
    let recovered = 0;
    for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || alreadyMounted.has(entry.name)) continue;
      const home = new AgentHome(join(agentsRoot, entry.name));
      if (!existsSync(home.metadataPath)) continue;
      try {
        const spec = await loadAgentSpecFromDisk(entry.name, agentsRoot);
        if (worker.supervisor()) await worker.runAgent(entry.name, {}, spec);
        else worker.runAgentSync(entry.name, {}, spec);
        recovered++;
        process.stdout.write(`   ↻ recovered ${entry.name} (lease expired while down)\n`);
      } catch (err) {
        process.stderr.write(
          `   ✗ recover ${entry.name}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (recovered > 0) {
      process.stdout.write(`🧬 recovered ${recovered} agent(s) from disk scan; heartbeat will reconcile their leases\n`);
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
 * `agent.json` is authoritative for model selection, reasoning effort, and
 * built-in Hand selection (`hands.builtin`); everything else (projectRoot,
 * ensureDefaultMcpConfig) is intentionally minimal — the SDK rebuilds the
 * rest from the on-disk home (sessions/, skills/, .mcp.json). `projectRoot`
 * is left undefined because nothing persists it; agents that need it must be
 * re-created through the full a8s createAgent path.
 */
async function loadAgentSpecFromDisk(agentId: string, agentsRoot: string): Promise<WorkerAgentSpec> {
  const workspace = join(agentsRoot, agentId);
  const home = new AgentHome(workspace);
  const raw = await import('node:fs/promises').then((m) => m.readFile(home.metadataPath, 'utf-8'));
  const meta = JSON.parse(raw) as {
    id?: string;
    model?: string;
    reasoningEffort?: WorkerAgentSpec['reasoningEffort'];
    hands?: { builtin?: string[] };
  };
  if (!meta.model) {
    throw new Error(`agent.json at ${home.metadataPath} has no "model" — cannot rehydrate`);
  }
  // Built-in Hand selection is authoritative on disk so a restart keeps the
  // same Hands instead of silently reverting to the all-on default. Absent
  // `hands` (agents created before this field) → both on, matching history.
  const builtinHands = selectBuiltinHands(meta.hands?.builtin);
  return {
    agentId,
    workspace,
    home,
    model: meta.model,
    ...(meta.reasoningEffort ? { reasoningEffort: meta.reasoningEffort } : {}),
    ensureDefaultMcpConfig: false,
    ...(builtinHands.workspace === false ? { workspaceTools: false } : {}),
    ...(builtinHands.web === false ? { webTools: false } : {}),
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[berry-worker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
