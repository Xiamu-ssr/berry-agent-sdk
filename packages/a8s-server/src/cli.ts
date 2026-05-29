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

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DefaultCredentialStore } from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import { createObserver } from '@berry-agent/observe';
import {
  MemoryRuntimeOrchestrationStore,
  RuntimeOrchestrator,
  type RuntimeOrchestrationStore,
} from '@berry-agent/runtime';
import { A8sServer } from './server.js';
import { ensureAdminAgent, ensureLocalWorker } from './bootstrap.js';

const USAGE = `berry-a8s — Berry Agent control-plane service

Usage:
  berry-a8s start [options]
  berry-a8s --help

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

  --local-worker        Spin up an in-process worker on the same host (so a
                        fresh a8s has capacity > 0 without deploying a
                        separate worker first). Default: off.
  --data-root <path>    Local worker's private data dir (observe.db, creds).
                        Default: /var/berry/a8s/local-worker
  --agents-root <path>  Machine-scoped agent home dir. Shared across all
                        workers on this host so the same on-disk state
                        survives worker process crashes.
                        Default: /var/berry/agents
  --capacity <n>        Local worker capacity (default 4).

  --admin-agent         Ensure a 'berry-admin' agent is mounted on the local
                        worker, with cluster-admin tools installed. Implies
                        --local-worker. Requires --models-config so the
                        agent's LLM provider can resolve. Default: off.
  --models-config <p>   JSON file with { providers, models, tiers } in
                        @berry-agent/models shape. Required when
                        --local-worker or --admin-agent is set.

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
      'local-worker': { type: 'boolean' },
      'admin-agent': { type: 'boolean' },
      'data-root': { type: 'string' },
      'agents-root': { type: 'string' },
      capacity: { type: 'string' },
      'models-config': { type: 'string' },
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
  const wantLocalWorker = !!values['local-worker'] || !!values['admin-agent'];
  const wantAdminAgent = !!values['admin-agent'];
  const dataRoot = values['data-root'] ?? '/var/berry/a8s/local-worker';
  const agentsRoot = values['agents-root'] ?? '/var/berry/agents';
  const capacity = values.capacity ? parseInt(values.capacity, 10) : 4;
  if (capacity < 0 || !Number.isFinite(capacity)) {
    process.stderr.write(`invalid --capacity: ${values.capacity}\n`);
    return 2;
  }

  let registry: ModelsRegistry | undefined;
  if (wantLocalWorker) {
    if (!values['models-config']) {
      process.stderr.write('--local-worker / --admin-agent requires --models-config <path>\n');
      return 2;
    }
    try {
      registry = JSON.parse(readFileSync(values['models-config'], 'utf-8')) as ModelsRegistry;
    } catch (err) {
      process.stderr.write(
        `failed to load --models-config ${values['models-config']}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  if (wantAdminAgent && !adminToken) {
    process.stderr.write(
      '--admin-agent requires --admin-token: the admin agent calls the operator API and needs to authenticate against itself.\n',
    );
    return 2;
  }

  const orchestrator = new RuntimeOrchestrator({ store });
  const server = new A8sServer({
    port,
    controlPlane: { orchestrator },
    adminToken,
    advertiseUrl,
    wakeTickMs,
    version: '0.5.0-alpha.1',
  });

  const info = await server.start();
  process.stdout.write(`🍓 berry-a8s ready at ${info.url}\n`);

  if (wantLocalWorker && registry) {
    const env = {
      registry,
      credentials: new DefaultCredentialStore({ filePath: `${dataRoot}/creds.json` }),
      observer: createObserver({ dbPath: `${dataRoot}/observe.db` }),
    };
    const worker = await ensureLocalWorker(server, {
      env,
      dataRoot,
      agentsRoot,
      capacity,
    });
    process.stdout.write(`   local worker mounted (capacity ${capacity}, data ${dataRoot}, agents ${agentsRoot})\n`);

    if (wantAdminAgent && adminToken) {
      const agentId = await ensureAdminAgent(server, worker, agentsRoot, adminToken, {
        a8sPort: port,
      });
      process.stdout.write(`   berry-admin agent ready (id ${agentId})\n`);
    }
  }

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
