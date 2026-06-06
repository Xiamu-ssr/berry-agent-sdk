#!/usr/bin/env node
// ============================================================
// @berry-agent/machine-connector — CLI entry
// ============================================================
// Starts a machine connector: a tiny HTTP daemon that lets an a8s
// cluster run commands on this host, registered as a Hand-providing
// ExecutionEnvironment (not a worker — no agent brains run here).
//
// Usage:
//   berry-machine start --a8s https://a8s.example.com --admin-token SECRET
//   berry-machine start --config /etc/berry/machine.json
//   berry-machine --help
//
// This is what the "add a machine" join script installs + runs. The
// agent then drives this machine through its exec Hand (e.g. to install
// a worker), instead of the operator copy-pasting setup scripts.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { startMachineConnector } from './connector.js';

const VERSION = '0.5.0-alpha.1';

const USAGE = `berry-machine — Berry Agent machine connector

Usage:
  berry-machine start [--config <path>] [flags]
  berry-machine --help

Options:
  --config <path>      Optional JSON config; flags override its values.
  --a8s <url>          a8s control plane URL. Required (flag or config).
  --admin-token <s>    Bootstrap secret (a8s --admin-token). Required for a
                       secured a8s; env BERRY_A8S_ADMIN_TOKEN.
  --machine-id <id>    Stable id (default: os.hostname()).
  --port <n>           HTTP port to listen on (default: 7200).
  --bind-host <h>      Hostname/IP advertised to a8s (default: os.hostname()).
  --heartbeat-ttl <ms> Heartbeat TTL (default: 30000).
  --mcp-config <path>  Path to a .mcp.json whose servers this machine
                       proxies as Hands (default: <cwd>/.mcp.json if present).
                       The agent sees machine_<id>__<server>_<tool> tools.
  --version            Print version
  --help               Show this help

The connector runs commands through a bare NodeExecutor by default —
i.e. the cluster can do on this host whatever the invoking shell can.
For anything but a throwaway box, front it with an OS sandbox (planned
config: "sandbox": true) or run it as a low-privilege user.
`;

const configSchema = z.object({
  a8s: z.string().url().optional(),
  adminToken: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  bindHost: z.string().min(1).optional(),
  heartbeatTtlMs: z.number().int().positive().optional(),
  labels: z.record(z.string()).optional(),
  mcpConfig: z.string().min(1).optional(),
}).strict();

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`berry-machine ${VERSION}\n`);
    return 0;
  }
  if (argv[0] !== 'start') {
    process.stderr.write(`unknown subcommand: ${argv[0]}\n\n${USAGE}`);
    return 2;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: 'string' },
      a8s: { type: 'string' },
      'admin-token': { type: 'string' },
      'machine-id': { type: 'string' },
      port: { type: 'string' },
      'bind-host': { type: 'string' },
      'heartbeat-ttl': { type: 'string' },
      'mcp-config': { type: 'string' },
    },
    allowPositionals: false,
  });

  let config: z.infer<typeof configSchema> = {};
  if (values.config) {
    try {
      config = configSchema.parse(JSON.parse(readFileSync(values.config, 'utf-8')));
    } catch (err) {
      process.stderr.write(`failed to read --config ${values.config}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const a8sUrl = values.a8s ?? config.a8s;
  if (!a8sUrl) {
    process.stderr.write('--a8s <url> is required (flag or config)\n');
    return 2;
  }
  const port = values.port ? parseInt(values.port, 10) : (config.port ?? 7200);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`invalid --port: ${values.port}\n`);
    return 2;
  }
  const heartbeatTtlMs = values['heartbeat-ttl']
    ? parseInt(values['heartbeat-ttl'], 10)
    : (config.heartbeatTtlMs ?? 30_000);

  // All wiring (MCP host → daemon → register) lives in startMachineConnector
  // so a GUI client can bundle the connector with the same one call. The CLI
  // only adds what a long-running process needs: signal handling + blocking.
  const connector = await startMachineConnector({
    a8sUrl,
    machineId: values['machine-id'] ?? config.machineId,
    port,
    bindHost: values['bind-host'] ?? config.bindHost,
    adminToken: values['admin-token'] ?? config.adminToken,
    heartbeatTtlMs,
    labels: config.labels,
    mcpConfigPath: values['mcp-config'] ?? config.mcpConfig,
    version: VERSION,
  });

  process.stdout.write(`🖐  berry-machine "${connector.machineId}" listening on ${connector.callbackUrl}\n`);
  process.stdout.write(`   platform: ${connector.platform}\n`);
  if (connector.mcp) {
    process.stdout.write(`   MCP: ${connector.mcp.servers.length} server(s), ${connector.mcp.toolCount} tool(s)\n`);
  }
  process.stdout.write(`🔗 registered with a8s at ${a8sUrl}\n`);

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[berry-machine] received ${signal}, withdrawing...\n`);
    try {
      await connector.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[berry-machine] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stderr.write(`[berry-machine] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
