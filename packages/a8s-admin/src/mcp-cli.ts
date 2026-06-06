#!/usr/bin/env node
// ============================================================
// @berry-agent/a8s-admin — berry-mcp CLI
// ============================================================
// MCP as a CLI, not a tool list. Per the settled projection model, MCP is a
// SECOND-CLASS citizen: its tools do NOT flatten into the agent's model-
// visible tool list (that bloats the list and buries the first-class hands).
// Instead an agent discovers and calls MCP through this CLI, exactly the way
// `berry-team` turns collaboration into a CLI rather than baked-in tools.
//
// Why a CLI (not Hand tools): a machine can proxy dozens of MCP tools. Putting
// every one in the tool list is the very "几十个 tool 平铺" problem we're
// fixing. The agent keeps a small, first-class tool surface (its hands) and
// reaches MCP on demand: `berry-mcp tools <machine>` to discover, then
// `berry-mcp call <machine> <server> <tool> --input '{...}'` to invoke. The
// call is brokered by a8s → connector → the machine's local MCP server, the
// same one-shot path the old projected tools used — only the discovery/invoke
// surface changed from N tools to one CLI.
//
// Auth: reads a8s URL + token from flags or env (BERRY_A8S_URL /
// BERRY_A8S_ADMIN_TOKEN). An agent running on a worker already has both in its
// process env, so it just runs the command.

import { parseArgs } from 'node:util';
import { A8sClient } from '@berry-agent/client';

const USAGE = `berry-mcp — discover and call MCP tools on cluster machines

Usage:
  berry-mcp <command> [args] [--a8s <url>] [--token <token>] [--json]

Connection (each falls back to env, then localhost):
  --a8s <url>     a8s base URL   (env BERRY_A8S_URL, default http://localhost:8080)
  --token <tok>   token          (env BERRY_A8S_ADMIN_TOKEN)
  --json          print raw JSON instead of a human summary

Commands:
  list                           List machines that proxy MCP servers ({machine, servers, tools}).
  tools <machine>                List the MCP tools a machine exposes ({server, name, description}).
       [--server <name>]           Only tools from this MCP server.
  call <machine> <server> <tool> Invoke one MCP tool on a machine.
       --input '<json>'            Tool arguments as a JSON object (default {}).

Examples:
  berry-mcp list
  berry-mcp tools mac-1
  berry-mcp tools mac-1 --server playwright
  berry-mcp call mac-1 playwright browser_navigate --input '{"url":"https://example.com"}'
`;

/** Injectable side-effects so the CLI is testable without real env/network/process. */
export interface McpCliDeps {
  makeClient?: (a8sUrl: string, token: string) => Pick<A8sClient,
    'listMachines' | 'machineMcpManifest' | 'machineMcpInvoke'>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function main(argv: string[], deps: McpCliDeps = {}): Promise<number> {
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
      server: { type: 'string' },
      input: { type: 'string' },
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
      case 'list': {
        const { machines } = await client.listMachines();
        const withMcp = machines.filter((m) => m.mcpServers.length > 0);
        out(
          withMcp.length === 0
            ? '(no machines proxy MCP servers)'
            : withMcp.map((m) => `${m.machineId}\t${m.mcpServers.join(', ')}\t(${m.mcpToolCount} tool${m.mcpToolCount === 1 ? '' : 's'})`).join('\n'),
          withMcp.map((m) => ({ machine: m.machineId, servers: m.mcpServers, tools: m.mcpToolCount })),
        );
        return 0;
      }
      case 'tools': {
        const machineId = rest[0];
        if (!machineId) { writeErr('tools needs a <machine>\n'); return 2; }
        const manifest = await client.machineMcpManifest(machineId);
        const tools = values.server
          ? manifest.tools.filter((t) => t.server === values.server)
          : manifest.tools;
        out(
          tools.length === 0
            ? `(machine "${machineId}" exposes no MCP tools${values.server ? ` for server "${values.server}"` : ''})`
            : tools.map((t) => `${t.server}\t${t.name}\t${t.description ?? ''}`.trimEnd()).join('\n'),
          tools,
        );
        return 0;
      }
      case 'call': {
        const [machineId, server, tool] = rest;
        if (!machineId || !server || !tool) {
          writeErr('call needs <machine> <server> <tool>\n');
          return 2;
        }
        let input: Record<string, unknown> = {};
        if (values.input) {
          try {
            const parsed = JSON.parse(values.input);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              writeErr('--input must be a JSON object\n');
              return 2;
            }
            input = parsed as Record<string, unknown>;
          } catch (err) {
            writeErr(`--input is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
            return 2;
          }
        }
        const reply = await client.machineMcpInvoke(machineId, { server, name: tool, input });
        out(reply.content || '(no output)', reply);
        return reply.isError ? 1 : 0;
      }
      default:
        writeErr(`unknown command: ${command ?? '(none)'}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    writeErr(`berry-mcp ${command ?? ''} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Auto-run only when invoked as the CLI entrypoint (not when imported by a test).
const invokedDirectly = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && /mcp-cli\.(js|ts)$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[berry-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
