// ============================================================
// Routes: Team (project-scoped worklist + message log)
// ============================================================
//
// The emergent Team's shared state. A team is just the agents sharing a
// `project` label; the only state it needs — a worklist and a message log —
// is project-scoped and lives here (replacing leader-local files that don't
// exist under brain-hand separation). Membership is computed elsewhere from
// listAgents + labels.project, so there is no member table here.
//
// Admin-scoped: the worker-injected team tools call these with the admin
// token (same as the wake scheduler), and the claw Teams page reads them via
// its product token resolved to admin scope. Pure CRUD over TeamStore.

import {
  worklistResponseSchema,
  worklistCreateRequestSchema,
  worklistPatchRequestSchema,
  teamMessagesResponseSchema,
  teamMessageAppendRequestSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireProductScope } from '../auth.js';
import { withAudit } from '../middleware.js';

export function teamRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- Worklist: list ----
    {
      method: 'GET',
      pattern: '/v1/projects/:project/worklist',
      name: 'GET /v1/projects/:project/worklist',
      middleware: [requireProductScope(deps)],
      handler: async ({ params, res }) => {
        const tasks = await deps.teams.listWorklist(decodeURIComponent(params.project));
        writeJson(res, 200, worklistResponseSchema.parse({ tasks }));
      },
    },

    // ---- Worklist: add task ----
    {
      method: 'POST',
      pattern: '/v1/projects/:project/worklist',
      name: 'POST /v1/projects/:project/worklist',
      middleware: [
        requireProductScope(deps),
        withAudit(deps.audit, { action: 'team.worklist.add', target: (ctx) => ctx.params.project }),
      ],
      handler: async ({ params, req, res }) => {
        const parsed = worklistCreateRequestSchema.parse(await readJsonBody(req));
        const task = await deps.teams.addTask(decodeURIComponent(params.project), parsed);
        writeJson(res, 200, task);
      },
    },

    // ---- Worklist: patch task (claim / status / assignee) ----
    {
      method: 'PATCH',
      pattern: '/v1/projects/:project/worklist/:taskId',
      name: 'PATCH /v1/projects/:project/worklist/:taskId',
      middleware: [
        requireProductScope(deps),
        withAudit(deps.audit, { action: 'team.worklist.patch', target: (ctx) => `${ctx.params.project}/${ctx.params.taskId}` }),
      ],
      handler: async ({ params, req, res }) => {
        const parsed = worklistPatchRequestSchema.parse(await readJsonBody(req));
        const task = await deps.teams.patchTask(decodeURIComponent(params.project), params.taskId, parsed);
        if (!task) throw httpError(404, 'unknown_task', `task "${params.taskId}" not found`);
        writeJson(res, 200, task);
      },
    },

    // ---- Messages: read ----
    {
      method: 'GET',
      pattern: '/v1/projects/:project/messages',
      name: 'GET /v1/projects/:project/messages',
      middleware: [requireProductScope(deps)],
      handler: async ({ params, res }) => {
        const messages = await deps.teams.listMessages(decodeURIComponent(params.project));
        writeJson(res, 200, teamMessagesResponseSchema.parse({ messages }));
      },
    },

    // ---- Messages: append ----
    {
      method: 'POST',
      pattern: '/v1/projects/:project/messages',
      name: 'POST /v1/projects/:project/messages',
      middleware: [
        requireProductScope(deps),
        withAudit(deps.audit, { action: 'team.message.append', target: (ctx) => ctx.params.project }),
      ],
      handler: async ({ params, req, res }) => {
        const parsed = teamMessageAppendRequestSchema.parse(await readJsonBody(req));
        const msg = await deps.teams.appendMessage(decodeURIComponent(params.project), parsed);
        writeJson(res, 200, msg);
      },
    },
  ];
}
