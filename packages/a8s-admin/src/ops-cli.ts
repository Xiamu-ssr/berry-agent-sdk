#!/usr/bin/env node
// ============================================================
// @berry-agent/a8s-admin — berry-a8s-ops CLI
// ============================================================
// Cluster operations as a CLI instead of a fixed set of model tools.
//
// Why a CLI (not Hand tools): operating a8s is *knowledge*, not a built-in
// capability of every agent. The berry-admin agent gets a generic shell
// Hand plus an `ops` skill that teaches it to run `berry-a8s-ops <cmd>`.
// Adding a new operation = a new subcommand here + a line in the skill —
// the agent's tool surface never changes, and no execution-layer code
// (Hand/env) carries cluster-ops semantics. This mirrors how "install a
// worker" is already a skill, not a connector RPC.
//
// Auth: reads a8s URL + admin token from flags or env
// (BERRY_A8S_URL / BERRY_A8S_ADMIN_TOKEN). On a worker hosting berry-admin
// both are already in the process env, so the agent just runs the command.

import { parseArgs } from 'node:util';
import { A8sClient } from '@berry-agent/client';

const USAGE = `berry-a8s-ops — operate an a8s cluster from the command line

Usage:
  berry-a8s-ops <command> [args] [--a8s <url>] [--token <token>] [--json]

Connection (each falls back to env, then localhost):
  --a8s <url>     a8s base URL          (env BERRY_A8S_URL, default http://localhost:8080)
  --token <tok>   admin token           (env BERRY_A8S_ADMIN_TOKEN)
  --json          print raw JSON instead of a human summary

Read commands:
  cluster                 Cluster snapshot: worker counts, capacity, agents, uptime.
  workers                 List workers (state, capacity, used, labels, heartbeat).
  agents                  List assigned agents ({ agentId, workerId }).
  leases                  Durable lease table (agent → worker bindings).
  machines                List registered machines (the machine layer).

Worker lifecycle:
  drain <workerId>        Stop scheduling new agents onto a worker (reversible).
  undrain <workerId>      Re-enable a drained worker.
  evict <workerId>        Hard-remove a worker; release its leases. Destructive.
  join-script             Print a worker-join bash snippet (embeds admin token).

Machine layer:
  machine-join-script     Print a machine-connector install snippet.

Examples:
  berry-a8s-ops cluster
  berry-a8s-ops drain worker-b
  berry-a8s-ops join-script
`;

/** Injectable side-effects so the CLI is testable without real env / network / process. */
export interface OpsCliDeps {
  /** Build the client from resolved url+token. Default: real A8sClient. */
  makeClient?: (a8sUrl: string, token: string) => Pick<A8sClient,
    'clusterReport' | 'listWorkers' | 'listAgents' | 'listLeases' | 'listMachines'
    | 'drainWorker' | 'undrainWorker' | 'evictWorker' | 'joinScript' | 'machineJoinScript'>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], deps: OpsCliDeps = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const writeErr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const env = deps.env ?? process.env;

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    writeOut(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      a8s: { type: 'string' },
      token: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const a8sUrl = values.a8s ?? env.BERRY_A8S_URL ?? 'http://localhost:8080';
  const token = values.token ?? env.BERRY_A8S_ADMIN_TOKEN;
  if (!token) {
    writeErr('no admin token: pass --token or set BERRY_A8S_ADMIN_TOKEN\n');
    return 2;
  }
  const client = deps.makeClient
    ? deps.makeClient(a8sUrl, token)
    : new A8sClient({ a8sUrl, token });
  const [command, ...rest] = positionals;
  const raw = !!values.json;

  const out = (human: string, data: unknown): void => {
    writeOut(raw ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
  };

  try {
    switch (command) {
      case 'cluster': {
        const r = await client.clusterReport();
        out(
          `workers: ${r.workerCount.active} active / ${r.workerCount.total} total `
          + `(${r.workerCount.draining} draining, ${r.workerCount.evicted} evicted)\n`
          + `capacity: ${r.capacity.used}/${r.capacity.total} used, ${r.capacity.available} available\n`
          + `agents: ${r.agentCount} · uptime: ${r.uptimeSeconds}s`,
          r,
        );
        return 0;
      }
      case 'workers': {
        const { workers } = await client.listWorkers();
        out(
          workers.length === 0
            ? '(no workers registered)'
            : workers.map((w) => `${w.workerId}\t${w.state}\t${w.used}/${w.capacity}\t${labelStr(w.labels)}`).join('\n'),
          workers,
        );
        return 0;
      }
      case 'agents': {
        const { agents } = await client.listAgents();
        out(
          agents.length === 0
            ? '(no agents assigned)'
            : agents.map((a) => `${a.agentId}\t${a.workerId ?? '(stranded)'}`).join('\n'),
          agents,
        );
        return 0;
      }
      case 'leases': {
        const { leases } = await client.listLeases();
        out(
          leases.length === 0
            ? '(no leases)'
            : leases.map((l) => `${l.agentId}\t${l.state}\t${l.workerId ?? l.holderId}`).join('\n'),
          leases,
        );
        return 0;
      }
      case 'machines': {
        const { machines } = await client.listMachines();
        out(
          machines.length === 0
            ? '(no machines registered)'
            : machines.map((m) => `${m.machineId}\t${m.state}\t${m.platform ?? '?'}\t${m.mcpToolCount} mcp tools`).join('\n'),
          machines,
        );
        return 0;
      }
      case 'drain':
      case 'undrain':
      case 'evict': {
        const workerId = rest[0];
        if (!workerId) { writeErr(`${command} needs a <workerId>\n`); return 2; }
        if (command === 'drain') await client.drainWorker(workerId);
        else if (command === 'undrain') await client.undrainWorker(workerId);
        else await client.evictWorker(workerId);
        out(`worker "${workerId}" ${command}ed`, { ok: true, workerId, action: command });
        return 0;
      }
      case 'join-script': {
        const r = await client.joinScript({});
        // Always print the script verbatim — it embeds the admin token.
        writeOut(`${r.script}\n`);
        return 0;
      }
      case 'machine-join-script': {
        const r = await client.machineJoinScript({});
        writeOut(`${r.script}\n`);
        return 0;
      }
      default:
        writeErr(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    writeErr(`berry-a8s-ops ${command} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function labelStr(labels?: Record<string, string>): string {
  if (!labels) return '';
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
}

// Auto-run only when invoked as the CLI entrypoint (not when imported by a
// test). `process.argv[1]` is the script path the bin was launched with.
const invokedDirectly = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && /ops-cli\.(js|ts)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[berry-a8s-ops] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
