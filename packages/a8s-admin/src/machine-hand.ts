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
import type { A8sOperatorClient } from './operator-client.js';

export interface MachineHandOptions {
  client: A8sOperatorClient;
  machineId: string;
  /** Platform hint surfaced in the tool description (helps the model). */
  platform?: string;
  /** Default cwd for commands when the model omits one. */
  defaultCwd?: string;
}

/**
 * Sanitize a machineId into a tool-name-safe fragment. Tool names must be
 * a stable identifier-ish string; machineIds can contain dots/dashes.
 */
function toolSafe(machineId: string): string {
  return machineId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build the exec tool for one machine. Exposed separately so the worker-daemon
 * resolver can inject it as a hostTool (no Hand wrapper). Machine exec is a
 * genuine execution-layer capability — unlike cluster ops, which moved to the
 * berry-a8s-ops CLI + skill (新-2).
 *
 * MCP is deliberately NOT projected here. Per the settled model, a machine's
 * MCP tools are second-class: they do not flatten into the agent's tool list
 * (a machine can proxy dozens — that's the very bloat we're avoiding). The
 * agent discovers and calls them through the `berry-mcp` CLI instead, brokered
 * by a8s via the same machineMcpInvoke path. So one machine = one first-class
 * `exec` tool; MCP stays on demand behind the CLI.
 */
export function buildMachineTools(options: MachineHandOptions): ToolRegistration[] {
  const { client, machineId } = options;
  const safe = toolSafe(machineId);
  const where = options.platform ? ` (${options.platform})` : '';
  const cwdHint = options.defaultCwd ? ` Defaults to ${options.defaultCwd}.` : '';
  return [
    {
      definition: {
        name: `machine_${safe}_exec`,
        description:
          `Run a shell command on machine "${machineId}"${where}. Use this to operate that `
          + `host — install/restart services, inspect state, run setup steps. The command `
          + `runs in the machine's real shell, so OS-specific behavior is the machine's. `
          + `Returns combined stdout/stderr. (For this machine's MCP tools, use the `
          + `berry-mcp CLI: \`berry-mcp tools ${machineId}\`.)`,
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
}

/** Wrap a machine's tools as a standalone Hand (for non-worker callers). */
export function createMachineHand(options: MachineHandOptions): Hand {
  return createToolRegistrationHand({
    id: `machine-${options.machineId}`,
    kind: 'remote-sandbox',
    displayName: `Machine ${options.machineId}`,
    env: options.machineId,
    tools: buildMachineTools(options),
  });
}
