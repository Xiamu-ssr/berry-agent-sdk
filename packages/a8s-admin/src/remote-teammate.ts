// ============================================================
// @berry-agent/a8s-admin — Remote teammate runtime factory
// ============================================================
//
// Bridges @berry-agent/team to a8s so a Team's leader can spawn
// teammates as first-class cluster agents instead of in-process
// runtimes. Returns a TeamAgentRuntime-shaped facade whose `send()`
// hops product → a8s → owning worker → real agent.
//
// Communication channels:
//   - **Leader → teammate**: `message_teammate` (sync RPC) forwards via
//     /v1/agents/:id/send and returns the awaited turn result, identical
//     semantics to in-process.
//   - **Teammate → leader** (async): the teammate's worker daemon (when
//     started with an admin token, which is required for joining a8s
//     anyway) auto-injects a `message_leader` hostTool that schedules a
//     wake against the leader's agentId via /v1/wakes/schedule. The
//     wake delivery loop in a8s-server sends the leader a structured
//     `[system wake] reason: teammate_message ...` prompt next tick.
//
// What you give up vs in-process: `addHand` on the facade throws —
// you cannot inject runtime objects across the network. Teammate-side
// behaviour must be expressible as labels or via the worker daemon's
// resolveSpec hook (the team-mode helper handles message_leader).

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  createAgentRequestSchema,
  createAgentResponseSchema,
  sendRequestSchema,
  sendResponseSchema,
  type SendResponse,
} from '@berry-agent/cluster-protocol';
import type { ManagedAgentTurnResult } from '@berry-agent/core';
import type { A8sOperatorClient } from './operator-client.js';

/**
 * Minimal shape compatible with @berry-agent/team's `TeamAgentRuntime`.
 * Duplicated here to avoid pulling team into a8s-admin (one-way deps).
 */
interface RemoteTeamAgentRuntime {
  hasHand(id: string): boolean;
  addHand(): void;
  send(prompt: string): Promise<ManagedAgentTurnResult>;
}

export interface RemoteTeammateRuntimeFactoryOptions {
  /** Already-configured operator client (carries a8sUrl + admin token). */
  client: A8sOperatorClient;
  /**
   * Workspace path the worker should use for the teammate. Either a bare
   * id (worker resolves to <agentsDir>/<id>) or an absolute path.
   * Defaults to the teammate id.
   */
  workspaceFor?: (teammateId: string) => string;
  /**
   * Resolve a model ref for the teammate. Tier wins over model. Defaults
   * to `tier:strong`, then `tier:${tier}` if the spec carries a tier,
   * then `spec.model` if explicit.
   */
  modelFor?: (spec: { tier?: string; model?: string }) => string;
}

/**
 * Build a TeammateRuntimeFactory the @berry-agent/team package can plug
 * into its `runtimeFactory` slot. The returned function:
 *   1. POSTs /v1/agents to create the teammate as a cluster agent.
 *   2. Returns a facade whose send() proxies to a8s.
 *
 * The factory does **not** persist or remember teammates — Team's
 * `team.json` is the source of truth. Re-creating an existing agent via
 * a8s is the caller's concern; this factory always asks a8s to create.
 */
export function createRemoteTeammateRuntimeFactory(
  options: RemoteTeammateRuntimeFactoryOptions,
) {
  const client = options.client;
  const workspaceFor = options.workspaceFor ?? ((id: string) => id);
  const modelFor =
    options.modelFor
    ?? ((spec) => spec.tier ? `tier:${spec.tier}` : spec.model ?? 'tier:strong');

  return async (spec: {
    id: string;
    role: string;
    systemPrompt: string;
    tier?: string;
    model?: string;
    project: string;
    leaderId: string;
  }): Promise<RemoteTeamAgentRuntime> => {
    const wire = createAgentRequestSchema.parse({
      spec: {
        agentId: spec.id,
        workspace: workspaceFor(spec.id),
        projectRoot: spec.project,
        model: modelFor(spec),
        ensureDefaultMcpConfig: false,
        labels: { team: 'true', role: spec.role, leader: spec.leaderId },
      },
      entry: {
        role: spec.role,
        systemPrompt: spec.systemPrompt,
        leaderId: spec.leaderId,
      },
    });
    const created = await client.createAgent(wire);
    return new RemoteTeammateRuntime(client, created.agentId);
  };
}

/**
 * Send-only facade over a cluster agent. Holds the agentId + client and
 * forwards every send() call through a8s. Sessions are server-managed:
 * the SDK auto-picks one when sessionId is omitted.
 */
class RemoteTeammateRuntime implements RemoteTeamAgentRuntime {
  constructor(
    private readonly client: A8sOperatorClient,
    public readonly agentId: string,
  ) {}

  hasHand(_id: string): boolean {
    return false;
  }

  addHand(): void {
    throw new Error(
      'addHand is not supported on a remote teammate runtime. ' +
      'Teammate-side tools must be pre-installed on the remote worker via its resolveSpec.',
    );
  }

  async send(prompt: string): Promise<ManagedAgentTurnResult> {
    const wire: SendResponse = await this.client.sendToAgent(this.agentId, { prompt });
    return wire.result as unknown as ManagedAgentTurnResult;
  }
}
