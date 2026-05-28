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

Options:
  --port <n>          HTTP port to listen on (default: 8080, env BERRY_A8S_PORT)
  --store <spec>      Orchestration store. One of:
                        memory                   (default, in-process only)
                        sqlite:///path/to.db     (requires @berry-agent/runtime-sqlite)
                      env BERRY_A8S_STORE
  --version           Print version
  --help              Show this help
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

  const orchestrator = new RuntimeOrchestrator({ store });
  const server = new A8sServer({
    port,
    controlPlane: { orchestrator },
    version: '0.5.0-alpha.1',
  });

  const info = await server.start();
  process.stdout.write(`🍓 berry-a8s ready at ${info.url}\n`);

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
