#!/usr/bin/env node
// ============================================================
// @berry-agent/a8s-server — CLI entry
// ============================================================
// Standalone binary that starts the control plane HTTP service.
// Usage:
//   berry-a8s start --port 8080 --store sqlite:///var/berry/orch.db
//   berry-a8s start --port 8080 --store memory     (testing only)
//   berry-a8s --help
//
// Configuration sources (highest wins):
//   1. CLI flags
//   2. Environment variables (BERRY_A8S_PORT, BERRY_A8S_STORE)
//   3. Defaults (port=8080, store=memory)

import { parseArgs } from 'node:util';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
  type RuntimeOrchestrationStore,
} from '@berry-agent/runtime';
import { A8sServer } from './server.js';

const USAGE = `berry-a8s — Berry Agent control-plane service

Usage:
  berry-a8s start [options]
  berry-a8s --help

a8s is a pure control plane: it schedules agents onto workers, brokers
the data plane, and serves the operator API + UI. It runs NO agents and
NO workers itself — deploy a \`berry-worker\` for capacity (even on this
same host), then create agents (including berry-admin) through the UI or
API. This keeps a8s generic; products like berry-admin are just agents
that run on a worker.

Options:
  --port <n>            HTTP port to listen on (default: 8080, env BERRY_A8S_PORT)
  --store <spec>        Orchestration store. One of:
                          memory                   (default, in-process only)
                          sqlite:///path/to.db     (requires @berry-agent/runtime-sqlite)
                        env BERRY_A8S_STORE
  --admin-token <s>     Shared secret required on /v1/agents, /v1/wakes, and
                        operator endpoints. Workers present it once at
                        registration as their bootstrap token.
                        env BERRY_A8S_ADMIN_TOKEN
                        If omitted, a8s runs in INSECURE DEV MODE — all
                        product-scope endpoints accept any caller. Never
                        use this for a real deployment.
  --advertise-url <u>   Externally-reachable base URL of this a8s. Used in
                        worker-join scripts the operator sends to new
                        hosts. Default http://localhost:<port>, which is
                        fine for local-only setups but wrong as soon as
                        workers run on other machines.
                        env BERRY_A8S_ADVERTISE_URL
  --wake-tick-ms <n>    Wake scheduler tick interval. Default 1000.
                        Set 0 to disable the in-process wake loop (e.g.
                        when an external scheduler drains the table).
  --audit-root <path>   Directory the audit log writes to. Audit is
                        append-only JSONL, one file per UTC day.
                        Default: /var/berry/a8s/audit
  --drain-timeout <ms>  How long shutdown waits for in-flight requests.
                        Default: 10000

  --version             Print version
  --help                Show this help
`;

async function main(argv: string[]): Promise<number> {
  // Treat the first positional as a subcommand for forward compatibility,
  // even though only "start" exists today.
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write('berry-a8s 0.5.0-alpha.1\n');
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
      port: { type: 'string' },
      store: { type: 'string' },
      'admin-token': { type: 'string' },
      'advertise-url': { type: 'string' },
      'wake-tick-ms': { type: 'string' },
      'audit-root': { type: 'string' },
      'drain-timeout': { type: 'string' },
    },
    allowPositionals: false,
  });

  const port = parseInt(values.port ?? process.env.BERRY_A8S_PORT ?? '8080', 10);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`invalid --port: ${values.port}\n`);
    return 2;
  }

  const storeSpec = values.store ?? process.env.BERRY_A8S_STORE ?? 'memory';
  const store = await resolveStore(storeSpec);
  const adminToken = values['admin-token'] ?? process.env.BERRY_A8S_ADMIN_TOKEN;
  const advertiseUrl = values['advertise-url'] ?? process.env.BERRY_A8S_ADVERTISE_URL;
  const wakeTickMs = values['wake-tick-ms'] !== undefined ? parseInt(values['wake-tick-ms'], 10) : undefined;
  if (wakeTickMs !== undefined && (!Number.isFinite(wakeTickMs) || wakeTickMs < 0)) {
    process.stderr.write(`invalid --wake-tick-ms: ${values['wake-tick-ms']}\n`);
    return 2;
  }
  const auditRoot = values['audit-root'] ?? process.env.BERRY_A8S_AUDIT_ROOT ?? '/var/berry/a8s/audit';
  const drainTimeoutMs = values['drain-timeout'] !== undefined ? parseInt(values['drain-timeout'], 10) : undefined;

  const orchestrator = new RuntimeOrchestrator({ store });
  const server = new A8sServer({
    port,
    controlPlane: { orchestrator },
    adminToken,
    advertiseUrl,
    wakeTickMs,
    auditRoot,
    drainTimeoutMs,
    version: '0.5.0-alpha.1',
  });

  const info = await server.start();
  process.stdout.write(`🍓 berry-a8s ready at ${info.url}\n`);
  process.stdout.write('   pure control plane — deploy a berry-worker for capacity, then create agents in the UI.\n');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[berry-a8s] received ${signal}, shutting down...\n`);
    try {
      await server.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[berry-a8s] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // Keep the process alive until a signal arrives.
  await new Promise<void>(() => { /* never resolves */ });
  return 0;
}

async function resolveStore(spec: string): Promise<RuntimeOrchestrationStore> {
  if (spec === 'memory') {
    return new MemoryRuntimeOrchestrationStore();
  }
  if (spec.startsWith('sqlite://')) {
    const path = spec.slice('sqlite://'.length);
    if (!path) {
      throw new Error('--store sqlite:// requires a path, e.g. sqlite:///var/berry/orch.db');
    }
    // Dynamic import so we don't force a SQLite dep when the user picks memory.
    const mod = await import('@berry-agent/runtime-sqlite');
    return new mod.SqliteRuntimeOrchestrationStore({ dbPath: path });
  }
  throw new Error(`unknown --store spec: ${spec}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[berry-a8s] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
