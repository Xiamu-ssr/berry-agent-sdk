#!/usr/bin/env node
// ============================================================
// @berry-agent/a8s-admin — berry-team CLI
// ============================================================
// Agent collaboration as a CLI, not a tool list.
//
// Why a CLI (not Hand tools): coordinating other agents is *knowledge*, not
// a built-in capability baked into every agent's tool surface. An agent that
// should lead a team or drive a flat cluster gets a generic shell Hand plus
// a `team` or `cluster` skill that teaches it to run `berry-team <cmd>`.
// a8s stays a neutral collaboration substrate — it only knows the primitives
// (spawn = createAgent+lease, message = send, discover = list, inspect =
// snapshot, disband = delete); it does NOT know "leader/teammate/cluster".
// Those shapes live entirely in the skills, not in a8s or the tool surface.
//
// Same three forms, same primitives, different skill:
//   - single agent : no collaboration skill.
//   - team         : `team` skill (a lead spawns + directs teammates).
//   - agents cluster: `cluster` skill (flat, no hierarchy — any agent may
//                     spawn, broadcast, claim work).
//
// Auth: reads a8s URL + token from flags or env (BERRY_A8S_URL /
// BERRY_A8S_ADMIN_TOKEN). An agent running on a worker already has both in
// its process env, so it just runs the command.

import { parseArgs } from 'node:util';
import { A8sClient } from '@berry-agent/client';

const USAGE = `berry-team — coordinate other agents from the command line

Usage:
  berry-team <command> [args] [--a8s <url>] [--token <token>] [--json]

Connection (each falls back to env, then localhost):
  --a8s <url>     a8s base URL   (env BERRY_A8S_URL, default http://localhost:8080)
  --token <tok>   token          (env BERRY_A8S_ADMIN_TOKEN)
  --json          print raw JSON instead of a human summary

Commands:
  peers                          List agents currently in the cluster ({id, worker}).
  spawn <id> --model <ref>       Create a new agent (a teammate / cluster member).
       [--label k=v ...]           Repeatable labels (e.g. --label team=demo --label role=reviewer).
       [--workspace <dir>]         Agent home dir (default: the id).
  send <id> <message...>         Send a turn to another agent; prints its final reply.
  status <id>                    Inspect a peer: model, status, hands, skills.
  disband <id>                   Remove an agent from the cluster. Destructive.

Examples:
  berry-team spawn reviewer --model tier:strong --label team=demo --label role=reviewer
  berry-team peers
  berry-team send reviewer "review the diff in /work and report findings"
  berry-team status reviewer
  berry-team disband reviewer
`;

/** Injectable side-effects so the CLI is testable without real env/network/process. */
export interface TeamCliDeps {
  makeClient?: (a8sUrl: string, token: string) => Pick<A8sClient,
    'listAgents' | 'createAgent' | 'sendToAgent' | 'agentSnapshot' | 'deleteAgent'>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], deps: TeamCliDeps = {}): Promise<number> {
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
      model: { type: 'string' },
      workspace: { type: 'string' },
      label: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });

  const a8sUrl = values.a8s ?? env.BERRY_A8S_URL ?? 'http://localhost:8080';
  const token = values.token ?? env.BERRY_A8S_ADMIN_TOKEN;
  if (!token) {
    writeErr('no token: pass --token or set BERRY_A8S_ADMIN_TOKEN\n');
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
      case 'peers': {
        const { agents } = await client.listAgents();
        out(
          agents.length === 0
            ? '(no agents in the cluster)'
            : agents.map((a) => `${a.agentId}\t${a.workerId ?? '(stranded)'}`).join('\n'),
          agents,
        );
        return 0;
      }
      case 'spawn': {
        const id = rest[0];
        if (!id) { writeErr('spawn needs an <id>\n'); return 2; }
        if (!values.model) { writeErr('spawn needs --model <ref>\n'); return 2; }
        const labels = parseLabels(values.label);
        const r = await client.createAgent({
          spec: {
            agentId: id,
            workspace: values.workspace ?? id,
            model: values.model,
            ...(Object.keys(labels).length ? { labels } : {}),
          },
        });
        out(`spawned "${id}" on worker ${r.workerId}`, r);
        return 0;
      }
      case 'send': {
        const id = rest[0];
        const message = rest.slice(1).join(' ');
        if (!id || !message) { writeErr('send needs <id> <message...>\n'); return 2; }
        const r = await client.sendToAgent(id, { prompt: message });
        const reply = (r.result as { assistantMessage?: { content?: unknown } })?.assistantMessage?.content;
        out(typeof reply === 'string' ? reply : JSON.stringify(reply ?? r.result), r);
        return 0;
      }
      case 'status': {
        const id = rest[0];
        if (!id) { writeErr('status needs an <id>\n'); return 2; }
        const s = await client.agentSnapshot(id);
        out(
          `${id}\tmodel=${s.model}\tstatus=${s.status}\n`
          + `hands: ${s.hands.map((h) => h.id).join(', ') || '(none)'}\n`
          + `skills: ${s.skills.map((k) => k.name).join(', ') || '(none)'}`,
          s,
        );
        return 0;
      }
      case 'disband': {
        const id = rest[0];
        if (!id) { writeErr('disband needs an <id>\n'); return 2; }
        await client.deleteAgent(id);
        out(`disbanded "${id}"`, { ok: true, agentId: id });
        return 0;
      }
      default:
        writeErr(`unknown command: ${command ?? '(none)'}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    writeErr(`berry-team ${command ?? ''} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** Parse repeated --label k=v into a record. Ignores malformed entries. */
function parseLabels(raw: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw ?? []) {
    const eq = item.indexOf('=');
    if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

// Auto-run only when invoked as the CLI entrypoint (not when imported by a test).
const invokedDirectly = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && /team-cli\.(js|ts)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[berry-team] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
