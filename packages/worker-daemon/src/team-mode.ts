// ============================================================
// @berry-agent/worker-daemon — Team-mode resolveSpec helper
// ============================================================
//
// The emergent Team: a team is just the set of agents that share a `project`
// label, with one of them labelled `role:leader`. There is no top-level team
// entity. Its only shared *state* — a worklist and a message log — lives in
// a8s, project-scoped (see a8s-server routes/team.ts). Membership is computed
// on demand from listAgents + labels.project.
//
// This helper wraps a host-provided resolveSpec and, for any wire spec whose
// labels say `team:true`, mounts the collaboration tools as a host hand. The
// toolset is label-driven:
//
//   • Every team member gets the *shared* tools (read the worklist, read its
//     inbox, post a message to the channel).
//   • A non-leader teammate also gets `message_leader` + `claim_task` /
//     `update_task` — the "do work, report up" loop.
//   • The leader (labels.role==='leader', or labels.leader===self) instead
//     gets the *command* tools: spawn / disband teammates, message a teammate,
//     list the roster, and add worklist tasks.
//
// Every tool is a thin a8s RPC — create/delete agents, schedule wakes, and the
// project-scoped worklist/message endpoints. None of them touch env or Hands;
// the team is self-contained in the control plane. Async delivery in both
// directions rides the wake scheduler: a posted message that targets a
// specific agent also schedules a wake so the recipient is nudged next tick.
//
// The "team briefing" the model reads is the host-hand display name (which
// names the leader + project) plus the tool descriptions themselves — the SDK
// renders user hands grouped by env with their tool names into the system
// prompt's hands-index block, so no bespoke system-prompt plumbing is needed.

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  adminAuthHeader,
  createAgentRequestSchema,
  listAgentsResponseSchema,
  scheduleWakeRequestSchema,
  worklistResponseSchema,
  worklistTaskSchema,
  teamMessagesResponseSchema,
  teamMessageSchema,
} from '@berry-agent/cluster-protocol';
import type { ToolRegistration } from '@berry-agent/core';
import type { WorkerAgentSpec } from '@berry-agent/worker';

export interface TeamModeResolverOptions {
  /** Base URL of the a8s control plane every team RPC hits. */
  a8sUrl: string;
  /** Admin token required by the team + agent + wake endpoints. */
  adminToken: string;
  /** Test injection. */
  fetch?: typeof fetch;
  /**
   * Random suffix generator for derived teammate ids. Injectable so tests can
   * make ids deterministic; defaults to a short base36 string.
   */
  randomSuffix?: () => string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type WireResolveInput = Parameters<
  Exclude<import('./daemon.js').WorkerDaemonOptions['resolveSpec'], undefined>
>[0];

/**
 * Wrap a host resolveSpec so any wire spec with `labels.team === 'true'` gets
 * the team collaboration tools auto-injected as host tools. Pass the result to
 * `new WorkerDaemon({ resolveSpec: ... })`. Host-supplied hostTools win on name
 * conflict (they were specified deliberately); team tools are appended.
 */
export function withTeamModeHostTools(
  baseResolve: (wire: WireResolveInput) => WorkerAgentSpec,
  options: TeamModeResolverOptions,
): (wire: WireResolveInput) => WorkerAgentSpec {
  return (wire) => {
    const baseSpec = baseResolve(wire);
    if (wire.labels?.team !== 'true') return baseSpec;

    const logger = options.logger ?? console;
    const self = wire.agentId;
    const leaderId = wire.labels?.leader;
    // The project key scopes the worklist + message log. Team agents are
    // always created with a projectRoot (the leader's project); without it the
    // shared state has no home, so skip the tools rather than guess.
    const project = wire.projectRoot;
    if (!project) {
      logger.warn?.(
        `[team-mode] agent ${self} has team:true but no projectRoot; skipping team tools`,
      );
      return baseSpec;
    }
    const isLeader = wire.labels?.role === 'leader' || (!!leaderId && leaderId === self);
    if (!isLeader && !leaderId) {
      logger.warn?.(
        `[team-mode] teammate ${self} has team:true but no leader label; skipping team tools`,
      );
      return baseSpec;
    }

    const teamTools = isLeader
      ? buildLeaderTools(self, project, options)
      : buildTeammateTools(self, leaderId!, project, options);

    const existing = Array.from(baseSpec.hostTools ?? []);
    const existingNames = new Set(existing.map((t) => t.definition.name));
    const additions = teamTools.filter((t) => !existingNames.has(t.definition.name));
    const displayName = isLeader
      ? `Team collaboration · you are the leader · project ${project}`
      : `Team collaboration · leader ${leaderId} · project ${project}`;
    return {
      ...baseSpec,
      hostTools: [...existing, ...additions],
      hostHandDisplayName: baseSpec.hostHandDisplayName ?? displayName,
    };
  };
}

// ------------------------------------------------------------
// a8s RPC plumbing
// ------------------------------------------------------------

interface TeamRpc {
  get<T>(path: string, parse: (raw: unknown) => T): Promise<T>;
  send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, parse: (raw: unknown) => T): Promise<T>;
}

function makeRpc(options: TeamModeResolverOptions): TeamRpc {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.a8sUrl.replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    [ADMIN_AUTH_HEADER]: adminAuthHeader(options.adminToken),
  };
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const resp = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`a8s ${method} ${path} failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  };
  return {
    get: async (path, parse) => parse(await call('GET', path)),
    send: async (method, path, body, parse) => parse(await call(method, path, body)),
  };
}

/** Schedule a wake so a target agent is nudged about a pending message next tick. */
async function nudge(rpc: TeamRpc, targetAgentId: string, reason: string, payload: Record<string, unknown>): Promise<void> {
  await rpc.send('POST', A8S_PATHS.wakesSchedule, scheduleWakeRequestSchema.parse({
    agentId: targetAgentId,
    dueAt: 0,
    reason,
    payload,
  }), (raw) => raw);
}

function ok(content: string): { content: string } {
  return { content };
}
function fail(err: unknown): { content: string; isError: true } {
  return { content: err instanceof Error ? err.message : String(err), isError: true };
}

// ------------------------------------------------------------
// Shared tools (every team member)
// ------------------------------------------------------------

function buildSharedTools(self: string, project: string, rpc: TeamRpc): ToolRegistration[] {
  return [
    {
      definition: {
        name: 'read_worklist',
        description:
          'List the team worklist for this project — every task and its status ' +
          '(unclaimed / claimed / in_progress / done / failed) plus who it is ' +
          'assigned to. Read this before claiming work so you do not duplicate ' +
          'a teammate.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        try {
          const { tasks } = await rpc.get(A8S_PATHS.projectWorklist(project), (r) => worklistResponseSchema.parse(r));
          if (!tasks.length) return ok('worklist is empty');
          const lines = tasks.map((t) =>
            `• [${t.status}] ${t.id} — ${t.title}` +
            (t.assignee ? ` (→ ${t.assignee})` : '') +
            (t.failureReason ? ` ✗ ${t.failureReason}` : ''),
          );
          return ok(lines.join('\n'));
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'read_inbox',
        description:
          'Read messages on the team channel addressed to you (or broadcast to ' +
          'everyone). Use this to pick up replies and instructions. Messages are ' +
          'returned oldest-first.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        try {
          const { messages } = await rpc.get(A8S_PATHS.projectMessages(project), (r) => teamMessagesResponseSchema.parse(r));
          const mine = messages.filter((m) => m.to === self || m.to === '@broadcast');
          if (!mine.length) return ok('inbox is empty');
          return ok(mine.map((m) => `[${m.from} → ${m.to}] ${m.content}`).join('\n'));
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'post_message',
        description:
          'Post a message to the team channel. `to` is a teammate agent id, ' +
          '`@leader`, or `@broadcast` (everyone). This appends to the shared log ' +
          'but does NOT wake the recipient — use `message_leader` / ' +
          '`message_teammate` when you need the recipient nudged to act now.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient: an agent id, "@leader", or "@broadcast".' },
            content: { type: 'string', description: 'Plain-text message body.' },
          },
          required: ['to', 'content'],
        },
      },
      execute: async (input) => {
        const to = String(input.to ?? '').trim();
        const content = String(input.content ?? '').trim();
        if (!to || !content) return fail(new Error('both `to` and `content` are required'));
        try {
          await rpc.send('POST', A8S_PATHS.projectMessages(project), { from: self, to, content }, (r) => teamMessageSchema.parse(r));
          return ok(`posted to ${to}`);
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}

// ------------------------------------------------------------
// Teammate tools (non-leader members)
// ------------------------------------------------------------

function buildTeammateTools(
  self: string,
  leaderId: string,
  project: string,
  options: TeamModeResolverOptions,
): ToolRegistration[] {
  const rpc = makeRpc(options);
  return [
    ...buildSharedTools(self, project, rpc),
    {
      definition: {
        name: 'message_leader',
        description:
          `Send an asynchronous message to your leader (${leaderId}) and wake ` +
          `them to read it next tick. Use for "I finished task X" / "I am ` +
          `blocked on Y / I need a decision". This is not RPC — the leader ` +
          `replies in their own turn. Keep it short; embed structured data as ` +
          `JSON inside the body if needed.`,
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Plain-text message body.' } },
          required: ['content'],
        },
      },
      execute: async (input) => {
        const content = String(input.content ?? '').trim();
        if (!content) return fail(new Error('content is required'));
        try {
          await rpc.send('POST', A8S_PATHS.projectMessages(project), { from: self, to: leaderId, content }, (r) => teamMessageSchema.parse(r));
          await nudge(rpc, leaderId, 'teammate_message', { from: self, to: leaderId, content });
          return ok(`delivered to ${leaderId} via a8s wake queue`);
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'claim_task',
        description:
          'Claim an unclaimed worklist task as yours, then start working it. ' +
          'Sets the task to "claimed" with you as the assignee. Read the worklist ' +
          'first and only claim tasks that are still unclaimed.',
        inputSchema: {
          type: 'object',
          properties: { taskId: { type: 'string', description: 'The worklist task id to claim.' } },
          required: ['taskId'],
        },
      },
      execute: async (input) => {
        const taskId = String(input.taskId ?? '').trim();
        if (!taskId) return fail(new Error('taskId is required'));
        try {
          const task = await rpc.send('PATCH', A8S_PATHS.projectWorklistTask(project, taskId), { status: 'claimed', assignee: self }, (r) => worklistTaskSchema.parse(r));
          return ok(`claimed ${task.id}: ${task.title}`);
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'update_task',
        description:
          'Update the status of a task you own: "in_progress" while working, ' +
          '"done" when complete, or "failed" with a reason if you cannot finish. ' +
          'Report meaningful failures to the leader with message_leader too.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'The worklist task id.' },
            status: { type: 'string', enum: ['in_progress', 'done', 'failed'], description: 'New status.' },
            failureReason: { type: 'string', description: 'Required when status is "failed".' },
          },
          required: ['taskId', 'status'],
        },
      },
      execute: async (input) => {
        const taskId = String(input.taskId ?? '').trim();
        const status = String(input.status ?? '').trim() as 'in_progress' | 'done' | 'failed';
        if (!taskId) return fail(new Error('taskId is required'));
        if (status === 'failed' && !String(input.failureReason ?? '').trim()) {
          return fail(new Error('failureReason is required when status is "failed"'));
        }
        try {
          const patch: Record<string, unknown> = { status };
          if (status === 'failed') patch.failureReason = String(input.failureReason).trim();
          const task = await rpc.send('PATCH', A8S_PATHS.projectWorklistTask(project, taskId), patch, (r) => worklistTaskSchema.parse(r));
          return ok(`${task.id} → ${task.status}`);
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}

// ------------------------------------------------------------
// Leader tools (command side)
// ------------------------------------------------------------

function buildLeaderTools(
  self: string,
  project: string,
  options: TeamModeResolverOptions,
): ToolRegistration[] {
  const rpc = makeRpc(options);
  const randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 8));

  return [
    ...buildSharedTools(self, project, rpc),
    {
      definition: {
        name: 'spawn_teammate',
        description:
          'Spawn a new teammate agent into your team. Give it a short role (e.g. ' +
          '"reviewer", "tester") and a system prompt describing its job. The ' +
          'teammate lands on a worker as a first-class cluster agent sharing your ' +
          'project, and gets the teammate collaboration tools automatically. ' +
          'Returns its agent id — use it with message_teammate / disband_teammate.',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'Short role label, e.g. "reviewer".' },
            systemPrompt: { type: 'string', description: 'The teammate\'s job briefing.' },
            model: { type: 'string', description: 'Optional model/tier ref (default tier:strong).' },
            agentId: { type: 'string', description: 'Optional explicit agent id (default <role>-<random>).' },
          },
          required: ['role', 'systemPrompt'],
        },
      },
      execute: async (input) => {
        const role = String(input.role ?? '').trim();
        const systemPrompt = String(input.systemPrompt ?? '').trim();
        if (!role || !systemPrompt) return fail(new Error('both `role` and `systemPrompt` are required'));
        const agentId = String(input.agentId ?? '').trim() || `${role.replace(/[^a-z0-9-_]/gi, '-').toLowerCase()}-${randomSuffix()}`;
        const model = String(input.model ?? '').trim() || 'tier:strong';
        try {
          const wire = createAgentRequestSchema.parse({
            spec: {
              agentId,
              workspace: agentId,
              projectRoot: project,
              model,
              ensureDefaultMcpConfig: false,
              labels: { team: 'true', role, leader: self, project },
            },
            entry: { role, systemPrompt, leaderId: self },
          });
          await rpc.send('POST', A8S_PATHS.agents, wire, (r) => r);
          return ok(`spawned teammate ${agentId} (role: ${role})`);
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'message_teammate',
        description:
          'Send an instruction to a specific teammate and wake them to act on it ' +
          'next tick. Use this to delegate or course-correct. For team-wide ' +
          'announcements use post_message with to:"@broadcast".',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Teammate agent id.' },
            content: { type: 'string', description: 'Plain-text instruction.' },
          },
          required: ['to', 'content'],
        },
      },
      execute: async (input) => {
        const to = String(input.to ?? '').trim();
        const content = String(input.content ?? '').trim();
        if (!to || !content) return fail(new Error('both `to` and `content` are required'));
        try {
          await rpc.send('POST', A8S_PATHS.projectMessages(project), { from: self, to, content }, (r) => teamMessageSchema.parse(r));
          await nudge(rpc, to, 'leader_message', { from: self, to, content });
          return ok(`delivered to ${to} via a8s wake queue`);
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'list_team',
        description:
          'List your team roster — every agent sharing this project, with its ' +
          'role and which worker it landed on. Membership is computed live from ' +
          'the cluster, so a freshly spawned teammate shows up here.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        try {
          const { agents } = await rpc.get(A8S_PATHS.agents, (r) => listAgentsResponseSchema.parse(r));
          const members = agents.filter((a) => a.labels?.project === project && a.labels?.team === 'true');
          if (!members.length) return ok('no team members yet (spawn one with spawn_teammate)');
          const lines = members.map((a) => {
            const role = a.labels?.role ?? 'member';
            const tag = a.agentId === self ? ' (you, leader)' : '';
            const where = a.workerId ? ` @${a.workerId}` : ' (unassigned)';
            return `• ${a.agentId} — ${role}${tag}${where}`;
          });
          return ok(lines.join('\n'));
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'disband_teammate',
        description:
          'Remove a teammate from the team when its work is done. This deletes the ' +
          'cluster agent and frees its worker slot. The worklist and message log ' +
          'are unaffected.',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: 'The teammate agent id to remove.' } },
          required: ['agentId'],
        },
      },
      execute: async (input) => {
        const agentId = String(input.agentId ?? '').trim();
        if (!agentId) return fail(new Error('agentId is required'));
        if (agentId === self) return fail(new Error('a leader cannot disband itself'));
        try {
          await rpc.send('DELETE', A8S_PATHS.agent(agentId), undefined, (r) => r);
          return ok(`disbanded ${agentId}`);
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      definition: {
        name: 'worklist_add',
        description:
          'Add a task to the team worklist so a teammate can claim and work it. ' +
          'Optionally assign it directly to a teammate; otherwise it starts ' +
          'unclaimed and anyone can pick it up.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short task title.' },
            description: { type: 'string', description: 'Optional detail / acceptance criteria.' },
            assignee: { type: 'string', description: 'Optional teammate agent id to assign directly.' },
          },
          required: ['title'],
        },
      },
      execute: async (input) => {
        const title = String(input.title ?? '').trim();
        if (!title) return fail(new Error('title is required'));
        try {
          const body: Record<string, unknown> = { title, createdBy: self };
          if (String(input.description ?? '').trim()) body.description = String(input.description).trim();
          if (String(input.assignee ?? '').trim()) body.assignee = String(input.assignee).trim();
          const task = await rpc.send('POST', A8S_PATHS.projectWorklist(project), body, (r) => worklistTaskSchema.parse(r));
          return ok(`added task ${task.id}: ${task.title}`);
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}
