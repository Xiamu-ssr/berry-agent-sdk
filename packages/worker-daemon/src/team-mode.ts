// ============================================================
// @berry-agent/worker-daemon — Team-mode resolveSpec helper
// ============================================================
//
// When a8s spawns a teammate via the createRemoteTeammateRuntimeFactory
// path, the wire spec carries labels.team === 'true' plus labels.leader
// and labels.role. The worker daemon receiving that spec needs to mount
// teammate-side tools so the teammate can:
//
//   - message its leader asynchronously (`message_leader`) — implemented
//     as a wake schedule against the leader's agentId via a8s. The wake
//     scheduler delivers it next tick, the leader gets a
//     `[system wake] reason: teammate_message` prompt, no in-process
//     coupling required.
//
//   - read the team worklist (TODO follow-up; not in this iteration).
//
// This helper *wraps* a user-provided resolveSpec, layering team tools
// onto specs whose labels say `team:true`. Hosts that don't care about
// teams pass their resolveSpec straight to WorkerDaemon; berry-worker
// CLI wraps with this helper by default.

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  scheduleWakeRequestSchema,
} from '@berry-agent/cluster-protocol';
import type { ToolRegistration } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';

export interface TeamModeResolverOptions {
  /** Base URL of the a8s control plane the wake schedule call hits. */
  a8sUrl: string;
  /** Admin token required by /v1/wakes/schedule. */
  adminToken: string;
  /** Test injection. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type WireResolveInput = Parameters<
  Exclude<import('./daemon.js').WorkerDaemonOptions['resolveSpec'], undefined>
>[0];

/**
 * Wrap a host resolveSpec so any wire spec with `labels.team === 'true'`
 * gets the teammate-side tools auto-injected as hostTools. Pass the
 * result to `new WorkerDaemon({ resolveSpec: ... })`.
 *
 * When a host already provides hostTools for a teammate, the team
 * tools are *appended* — host tools win on name conflict because they
 * were specified deliberately.
 */
export function withTeamModeHostTools(
  baseResolve: (wire: WireResolveInput) => WorkerAgentSpec,
  options: TeamModeResolverOptions,
): (wire: WireResolveInput) => WorkerAgentSpec {
  return (wire) => {
    const baseSpec = baseResolve(wire);
    if (wire.labels?.team !== 'true') return baseSpec;
    const leaderId = wire.labels?.leader;
    if (!leaderId) {
      (options.logger ?? console).warn?.(
        `[team-mode] agent ${wire.agentId} has team:true but no leader label; skipping team tools`,
      );
      return baseSpec;
    }
    const teamTools = buildTeammateTools(wire.agentId, leaderId, options);
    const existing = Array.from(baseSpec.hostTools ?? []);
    const existingNames = new Set(existing.map((t) => t.definition.name));
    const additions = teamTools.filter((t) => !existingNames.has(t.definition.name));
    return {
      ...baseSpec,
      hostTools: [...existing, ...additions],
      hostHandDisplayName: baseSpec.hostHandDisplayName ?? 'Teammate channel',
    };
  };
}

function buildTeammateTools(
  selfId: string,
  leaderId: string,
  options: TeamModeResolverOptions,
): ToolRegistration[] {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.a8sUrl.replace(/\/$/, '');

  const sendWake = async (reason: string, payload: Record<string, unknown>): Promise<void> => {
    const body = JSON.stringify(scheduleWakeRequestSchema.parse({
      agentId: leaderId,
      dueAt: Date.now(),
      reason,
      payload,
    }));
    const resp = await fetchImpl(`${baseUrl}${A8S_PATHS.wakesSchedule}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ADMIN_AUTH_HEADER]: adminAuthHeader(options.adminToken),
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`team-mode wake schedule failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
  };

  return [
    {
      definition: {
        name: 'message_leader',
        description:
          `Send an asynchronous message to your leader (${leaderId}). The leader receives ` +
          `it as the next wake on their queue and replies in their own time — this is not ` +
          `RPC. Use for "I finished task X" / "I need clarification on Y" updates. The ` +
          `message body should be a short, plain-text summary; embed structured data ` +
          `inside as JSON if needed.`,
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Plain-text message body.' },
          },
          required: ['content'],
        },
      },
      execute: async (input) => {
        const content = String(input.content ?? '').trim();
        if (!content) return { content: 'content is required', isError: true };
        try {
          await sendWake('teammate_message', {
            from: selfId,
            to: leaderId,
            content,
          });
          return { content: `delivered to ${leaderId} via a8s wake queue` };
        } catch (err) {
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    },
  ];
}
