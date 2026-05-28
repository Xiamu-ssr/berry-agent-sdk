/**
 * Team tool factories.
 *
 * Split out of team.ts to keep the Team class focused on state + lifecycle.
 * These functions take a `Team` and return ToolRegistration[]; the Team class
 * exposes `leaderTools()` / `teammateTools()` as thin delegators for the
 * documented public API.
 */
import { z, type ZodError, type ZodIssue } from 'zod';
import type { ToolRegistration } from '@berry-agent/core';
import { errorMessage, ToolGroup, joinZodPath } from '@berry-agent/core';
import type { Team } from './team.js';
import type { TeammateId } from './types.js';
import { WORKLIST_STATUS_VALUES } from './types.js';
import { WorklistError, type WorklistActor } from './worklist.js';
import { zWorklistTaskStatus } from './schema.js';

const zNonBlankString = z.string().refine((value) => value.trim().length > 0, 'is required.');
const zWorklistToolInput = z.object({
  action: zNonBlankString,
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignee: zNonBlankString.optional(),
  status: zWorklistTaskStatus.optional(),
  reason: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();
const zWorklistIdInput = zWorklistToolInput.extend({ id: zNonBlankString });
const zWorklistCreateInput = zWorklistToolInput.extend({ title: zNonBlankString });
type WorklistToolInput = z.infer<typeof zWorklistToolInput>;

/**
 * Leader-facing tools: spawn / message / list / disband + worklist + inbox.
 * Mounted via Team.leaderHand() on the leader runtime.
 */
export function buildLeaderTools(team: Team): ToolRegistration[] {
  return [
    spawnTeammateToolDefinition(team),
    {
      definition: {
        name: 'message_teammate',
        group: ToolGroup.Team,
        description:
          'Send a message to one of your teammates and wait for their reply. ' +
          "This is how you delegate work or ask questions. Returns the teammate's full response.",
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Teammate id, as used in spawn_teammate.' },
            content: { type: 'string', description: 'Your message to the teammate.' },
          },
          required: ['id', 'content'],
        },
      },
      execute: async (input) => {
        try {
          const reply = await team.messageTeammate(input.id as string, input.content as string);
          return {
            content: reply,
            forUser: `[Team] ${input.id} replied (${reply.length} chars)`,
          };
        } catch (err) {
          return {
            content: `message_teammate failed: ${errorMessage(err)}`,
            isError: true,
          };
        }
      },
    },
    {
      definition: {
        name: 'list_team',
        group: ToolGroup.Team,
        description: 'List all current teammates and their roles.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async () => {
        if (team.teammates.length === 0) {
          return { content: 'No teammates yet. Use spawn_teammate to recruit.' };
        }
        const lines = team.teammates.map((t) => {
          const modelInfo = t.tier ? ` [tier:${t.tier}]` : t.model ? ` (${t.model})` : '';
          return `- ${t.id} — ${t.role}${modelInfo}`;
        });
        return { content: `Team "${team.state.name}":\n${lines.join('\n')}` };
      },
    },
    {
      definition: {
        name: 'disband_teammate',
        group: ToolGroup.Team,
        description:
          'Remove a teammate from the team. Its session log is preserved for audit. ' +
          'Only use when the teammate role is no longer needed.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Teammate id to remove.' } },
          required: ['id'],
        },
      },
      execute: async (input) => {
        try {
          await team.disbandTeammate(input.id as string);
          return { content: `Teammate "${input.id}" disbanded.` };
        } catch (err) {
          return {
            content: `disband_teammate failed: ${errorMessage(err)}`,
            isError: true,
          };
        }
      },
    },
    worklistTool(team, '@leader'),
    {
      definition: {
        name: 'read_team_inbox',
        group: ToolGroup.Team,
        description:
          'Read messages teammates have sent to you (leader). Returns messages in chronological order. ' +
          'Useful when a teammate reports progress or asks a question via message_leader.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of most-recent messages to return (default 20).',
            },
          },
        },
      },
      execute: async (input) => {
        const limit = (input.limit as number | undefined) ?? 20;
        const all = await team.readMessages();
        const inbox = all.filter((m) => m.to === '@leader' && m.from !== '@leader');
        const recent = inbox.slice(-limit);
        if (recent.length === 0) return { content: 'Inbox empty.' };
        return {
          content: recent
            .map((m) => `[${new Date(m.ts).toISOString()}] ${m.from}: ${m.content}`)
            .join('\n'),
        };
      },
    },
  ];
}

/**
 * Teammate-facing tools: message_leader + worklist. Mounted automatically
 * when spawnTeammate creates a teammate runtime.
 */
export function buildTeammateTools(team: Team, ownId: TeammateId): ToolRegistration[] {
  return [
    {
      definition: {
        name: 'message_leader',
        group: ToolGroup.Team,
        description:
          'Send a message to your team leader. Use to report progress, ask for clarification, ' +
          'or request additional resources. Non-blocking — leader reads via read_team_inbox.',
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Your message to the leader.' } },
          required: ['content'],
        },
      },
      execute: async (input) => {
        try {
          await team.messageLeader(ownId, input.content as string);
          return { content: 'Message sent to leader.' };
        } catch (err) {
          return {
            content: `message_leader failed: ${errorMessage(err)}`,
            isError: true,
          };
        }
      },
    },
    worklistTool(team, ownId),
  ];
}

/**
 * spawn_teammate tool. The tier enum is populated dynamically from the host's
 * tier config at mount time so leaders pick from a meaningful list.
 */
function spawnTeammateToolDefinition(team: Team): ToolRegistration {
  const tiers = team.availableTiers();
  const tierSchema = tiers.length > 0
    ? {
        type: 'string' as const,
        enum: tiers,
        description:
          `Model tier for the teammate. Tiers map to concrete models at the host; they're the ` +
          `preferred way to pick a model (stable across model swaps). Available: ${tiers.join(', ')}. ` +
          `Omit to inherit the leader's model.`,
      }
    : {
        type: 'string' as const,
        description:
          `Model tier for the teammate (host-defined). Omit to inherit the leader's model.`,
      };
  return {
    definition: {
      name: 'spawn_teammate',
      group: ToolGroup.Team,
      description:
        'Recruit a new teammate into your team. Creates a *first-class agent* in the host ' +
        'registry (visible in the Agents tab, with its own session log and working dir) and ' +
        'marks it as a teammate of yours. Only the leader can call this.\n\n' +
        'Pick a model tier (not a raw model id) so the choice stays stable when models are ' +
        "swapped. Use for long-running specialist roles (e.g. a code reviewer, a researcher, " +
        "a test runner) where persistent conversation history matters.",
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique id for this teammate, e.g. "reviewer", "researcher". Used in message routing and as the host agent id.',
          },
          role: {
            type: 'string',
            description: 'Short display name / role description for UI (e.g. "Security Reviewer").',
          },
          systemPrompt: {
            type: 'string',
            description: "System prompt defining the teammate's role and behavior.",
          },
          tier: tierSchema,
          inheritTools: {
            type: 'boolean',
            description: 'Whether to inherit leader tools (default: true).',
          },
        },
        required: ['id', 'role', 'systemPrompt'],
      },
    },
    execute: async (input) => {
      try {
        const rec = await team.spawnTeammate({
          id: input.id as string,
          role: input.role as string,
          systemPrompt: input.systemPrompt as string,
          tier: input.tier as string | undefined,
          inheritTools: input.inheritTools as boolean | undefined,
        });
        return {
          content: `Teammate "${rec.id}" (${rec.role}) is ready. Use message_teammate to delegate.`,
          forUser: `[Team] Spawned teammate "${rec.id}" — ${rec.role}`,
        };
      } catch (err) {
        return {
          content: `spawn_teammate failed: ${errorMessage(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Worklist tool factory — one tool, many actions. Scoped to the caller's
 * identity (actor) so the state machine can enforce permissions. Leader
 * gets `@leader`, teammates get their own id.
 *
 * Why single-tool: token budget in the system prompt, and LLMs handle
 * multi-action tools well (cf. Anthropic's `bash` / `str_replace_editor`).
 */
function worklistTool(team: Team, actor: WorklistActor): ToolRegistration {
  const isLeader = actor === '@leader';
  const actions = isLeader
    ? 'list, view, create, update, delete, claim, start, complete, fail'
    : 'list, view, create, claim, start, complete, fail';
  return {
    definition: {
      name: 'worklist',
      group: ToolGroup.Team,
      description:
        `Shared team task board at <project>/.berry/worklist.json. Use this to coordinate ` +
        `work between team members. The state machine is enforced:\n` +
        `  unclaimed → claimed → in_progress → done | failed\n\n` +
        `Available actions (${actor}): ${actions}.\n\n` +
        (isLeader
          ? 'As leader you can also force any status via `update`, and delete tasks. '
            + 'Creating a task without `assignee` leaves it unclaimed for the team to pick up.'
          : 'Create captures your own follow-ups (self-assigned). '
            + 'Claim grabs an unclaimed task. Use start/complete/fail to drive your own tasks through the state machine.'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: isLeader
              ? ['list', 'view', 'create', 'update', 'delete', 'claim', 'start', 'complete', 'fail']
              : ['list', 'view', 'create', 'claim', 'start', 'complete', 'fail'],
            description: 'Which worklist operation to perform.',
          },
          id: { type: 'string', description: 'Task id (required for view/update/delete/claim/start/complete/fail).' },
          title: { type: 'string', description: 'Task title (create/update).' },
          description: { type: 'string', description: 'Task description / body (create/update).' },
          assignee: {
            type: 'string',
            description: 'Teammate id or "@leader" to assign to (create/update).',
          },
          status: {
            type: 'string',
            enum: [...WORKLIST_STATUS_VALUES],
            description: 'Force a status (leader update only — bypasses state machine).',
          },
          reason: {
            type: 'string',
            description: 'Failure reason (required for fail).',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags/labels (create/update).',
          },
        },
        required: ['action'],
      },
    },
    execute: async (input) => {
      let action = 'unknown';
      try {
        const parsedInput = parseWorklistToolInput(input);
        action = parsedInput.action;
        switch (action) {
          case 'list': {
            const tasks = await team.worklist.list();
            if (tasks.length === 0) return { content: 'Worklist empty.' };
            return {
              content: tasks
                .map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (@${t.assignee})` : ''}`)
                .join('\n'),
            };
          }
          case 'view': {
            const { id } = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.get(id);
            if (!task) return { content: `Task ${id} not found.`, isError: true };
            return { content: JSON.stringify(task, null, 2) };
          }
          case 'create': {
            const args = parseWorklistActionInput(zWorklistCreateInput, input);
            const task = await team.worklist.create(actor, {
              title: args.title,
              description: args.description,
              assignee: args.assignee,
              tags: args.tags,
            });
            return { content: `Created ${task.id}: ${task.title} [${task.status}]` };
          }
          case 'update': {
            const args = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.update(actor, args.id, {
              title: args.title,
              description: args.description,
              assignee: args.assignee,
              status: args.status,
              tags: args.tags,
              failureReason: args.reason,
            });
            return { content: `Updated ${task.id} → [${task.status}]` };
          }
          case 'delete': {
            const { id } = parseWorklistActionInput(zWorklistIdInput, input);
            await team.worklist.remove(actor, id);
            return { content: `Deleted ${id}.` };
          }
          case 'claim': {
            const { id } = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.claim(actor, id);
            return { content: `Claimed ${task.id}.` };
          }
          case 'start': {
            const { id } = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.start(actor, id);
            return { content: `Started ${task.id} (now in_progress).` };
          }
          case 'complete': {
            const { id } = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.complete(actor, id);
            return { content: `Completed ${task.id}.` };
          }
          case 'fail': {
            const args = parseWorklistActionInput(zWorklistIdInput, input);
            const task = await team.worklist.fail(
              actor,
              args.id,
              args.reason ?? '',
            );
            return { content: `Failed ${task.id}: ${task.failureReason}` };
          }
          default:
            return { content: `Unknown action: ${action}`, isError: true };
        }
      } catch (err) {
        const msg = errorMessage(err);
        return { content: `worklist ${action} failed: ${msg}`, isError: true };
      }
    },
  };
}

function parseWorklistToolInput(input: unknown): WorklistToolInput {
  return parseWorklistActionInput(zWorklistToolInput, input);
}

function parseWorklistActionInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new WorklistError(formatWorklistInputError(parsed.error));
}

function formatWorklistInputError(error: ZodError): string {
  const issue = error.issues[0];
  return `${formatIssuePath(issue?.path ?? [])} ${formatIssueMessage(issue)}`;
}

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) return '`input`';
  const [first, ...rest] = path;
  return joinZodPath(`\`${String(first)}\``, rest);
}

function formatIssueMessage(issue: ZodIssue | undefined): string {
  if (!issue) return 'is invalid.';
  if (issue.path[0] === 'status') return `must be one of: ${WORKLIST_STATUS_VALUES.join(', ')}.`;
  return issue.message;
}
