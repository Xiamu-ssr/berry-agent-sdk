// ============================================================
// @berry-agent/a8s-admin — Machine Hand
// ============================================================
// Projects a registered machine into model-visible tools so an agent can
// run commands on that machine. The tools call a8s's exec broker
// (A8sOperatorClient.machineExec) — a8s holds the machine token and
// forwards, so the agent never sees machine credentials.
//
// One Hand per machine (id = `machine-<machineId>`): "选 Hand = 选机器".
// The tool name embeds the machineId so an agent driving several machines
// sees `machine_mac-1_exec`, `machine_b_exec`, … with no ambiguity.
//
// This is the brain-side counterpart of the M3 connector + M4a broker.
// It is injected by the worker daemon via label convention (M4b's
// withMachineHostTools), exactly like cluster-admin and team tools — no
// a8s-server → a8s-admin coupling.

import { createToolRegistrationHand, type Hand, type ToolRegistration } from '@berry-agent/core';
import type { MachineMcpTool } from '@berry-agent/cluster-protocol';
import type { A8sOperatorClient } from './operator-client.js';

export interface MachineHandOptions {
  client: A8sOperatorClient;
  machineId: string;
  /** Platform hint surfaced in the tool description (helps the model). */
  platform?: string;
  /** Default cwd for commands when the model omits one. */
  defaultCwd?: string;
  /**
   * MCP tools this machine proxies, as reported in its manifest.
   * Each becomes a model-visible tool named
   * `machine_<id>__<server>_<tool>` that calls a8s's MCP invoke broker.
   * Omit/empty when the machine has no local MCP.
   */
  mcpTools?: readonly MachineMcpTool[];
}

/**
 * Sanitize a machineId into a tool-name-safe fragment. Tool names must be
 * a stable identifier-ish string; machineIds can contain dots/dashes.
 */
function toolSafe(machineId: string): string {
  return machineId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Coerce an MCP tool's reported input schema into the strict object-schema
 * shape ToolDefinition requires. MCP servers should report an object
 * schema, but be defensive: fall back to an empty object schema when the
 * shape is missing or not an object.
 */
function coerceObjectSchema(
  raw: Record<string, unknown> | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  if (raw && raw.type === 'object' && typeof raw.properties === 'object' && raw.properties !== null) {
    return {
      type: 'object',
      properties: raw.properties as Record<string, unknown>,
      required: Array.isArray(raw.required) ? (raw.required as string[]) : undefined,
    };
  }
  return { type: 'object', properties: {} };
}

/**
 * Build the exec tool(s) for one machine. Exposed separately so the
 * worker-daemon resolver can inject them as hostTools (no Hand wrapper).
 * Machine exec is a genuine execution-layer capability — unlike cluster
 * ops, which moved to the berry-a8s-ops CLI + skill (新-2).
 */
export function buildMachineTools(options: MachineHandOptions): ToolRegistration[] {
  const { client, machineId } = options;
  const safe = toolSafe(machineId);
  const where = options.platform ? ` (${options.platform})` : '';
  const cwdHint = options.defaultCwd ? ` Defaults to ${options.defaultCwd}.` : '';
  const tools: ToolRegistration[] = [
    {
      definition: {
        name: `machine_${safe}_exec`,
        description:
          `Run a shell command on machine "${machineId}"${where}. Use this to operate that `
          + `host — install/restart services, inspect state, run setup steps. The command `
          + `runs in the machine's real shell, so OS-specific behavior is the machine's. `
          + `Returns combined stdout/stderr.`,
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run on the machine.' },
            cwd: { type: 'string', description: `Working directory on the machine.${cwdHint}` },
            timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
          },
          required: ['command'],
        },
      },
      execute: async (input) => {
        const command = String(input.command ?? '').trim();
        if (!command) return { content: 'command is required', isError: true };
        try {
          const reply = await client.machineExec(machineId, {
            command,
            cwd: typeof input.cwd === 'string' && input.cwd.trim()
              ? input.cwd.trim()
              : (options.defaultCwd ?? '/'),
            env: {},
            timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
          });
          return { content: reply.output || '(no output)', isError: reply.isError || undefined };
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    },
  ];

  // One model-visible tool per MCP tool the machine proxies. Naming
  // mirrors Claude Code's `mcp__server__tool` but embeds the machine so an
  // agent driving several machines sees no ambiguity:
  //   machine_<id>__<server>_<tool>
  // The double underscore separates the machine namespace from the MCP
  // namespace; the upstream (server, name) pair is the dispatch key sent
  // to a8s's MCP invoke broker — a8s forwards to the connector, which
  // holds the persistent stdio connection to the actual MCP server.
  for (const mcp of options.mcpTools ?? []) {
    const safeServer = toolSafe(mcp.server);
    const safeTool = toolSafe(mcp.name);
    const name = `machine_${safe}__${safeServer}_${safeTool}`;
    tools.push({
      definition: {
        name,
        description:
          (mcp.description ? `${mcp.description}\n\n` : '')
          + `(MCP tool "${mcp.name}" from server "${mcp.server}" on machine "${machineId}"${where}.)`,
        inputSchema: coerceObjectSchema(mcp.inputSchema),
      },
      execute: async (input) => {
        try {
          const reply = await client.machineMcpInvoke(machineId, {
            server: mcp.server,
            name: mcp.name,
            input: input ?? {},
          });
          return { content: reply.content || '(no output)', isError: reply.isError || undefined };
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
      source: { kind: 'mcp', server: `${machineId}:${mcp.server}` },
    });
  }

  return tools;
}

/** Wrap a machine's tools as a standalone Hand (for non-worker callers). */
export function createMachineHand(options: MachineHandOptions): Hand {
  return createToolRegistrationHand({
    id: `machine-${options.machineId}`,
    kind: 'remote-sandbox',
    displayName: `Machine ${options.machineId}`,
    tools: buildMachineTools(options),
  });
}
