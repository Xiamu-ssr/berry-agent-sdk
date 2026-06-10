// ============================================================
// Routes: skill registry (operator catalog + install onto agent) — B6
// ============================================================
//
// a8s as the skill market. Operators browse the catalog (built-ins shipped
// with @berry-agent/a8s-admin + operator-registered skills) and install a
// chosen skill onto an agent. Installing fetches the skill's verbatim
// content from the registry and forwards it to the per-agent /skills
// endpoint on the owning worker — the same proxy path the product API uses.
//
// Invariant: a8s carries skill content VERBATIM. It parses frontmatter only
// to surface name/description in listings; it never rewrites the SKILL.md.
// The agent's loader is the single interpreter of skill format.

import {
  A8S_PATHS,
  WORKER_AUTH_HEADER,
  operatorSkillListResponseSchema,
  operatorSkillSchema,
  operatorSkillDetailSchema,
  operatorSkillRegisterRequestSchema,
  operatorSkillInstallResponseSchema,
  skillInstallRequestSchema,
  workerAuthHeader,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';
import { resolveAgentWorker } from './worker-proxy.js';

export function skillRegistryRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- Catalog: list (metadata only) ----
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorSkills,
      name: 'GET /v1/operator/skills',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const skills = (await deps.skills.list()).map((s) => operatorSkillSchema.parse({
          name: s.name,
          description: s.description,
          builtin: s.builtin,
          extraFileCount: s.files.length,
        }));
        writeJson(res, 200, operatorSkillListResponseSchema.parse({ skills }));
      },
    },

    // ---- Catalog: register/update ----
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorSkills,
      name: 'POST /v1/operator/skills',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'skill.register', target: (ctx) => ctx.params.name ?? '' }),
      ],
      handler: async ({ req, res }) => {
        const parsed = operatorSkillRegisterRequestSchema.parse(await readJsonBody(req));
        try {
          const skill = await deps.skills.register(parsed);
          writeJson(res, 200, operatorSkillSchema.parse({
            name: skill.name,
            description: skill.description,
            builtin: skill.builtin,
            extraFileCount: skill.files.length,
          }));
        } catch (err) {
          throw httpError(409, 'skill_conflict', err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ---- Catalog: detail (full content, verbatim) ----
    {
      method: 'GET',
      pattern: '/v1/operator/skills/:name',
      name: 'GET /v1/operator/skills/:name',
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, res }) => {
        const skill = await deps.skills.get(params.name);
        if (!skill) {
          throw httpError(404, 'unknown_skill', `skill "${params.name}" not found`);
        }
        writeJson(res, 200, operatorSkillDetailSchema.parse({
          name: skill.name,
          description: skill.description,
          builtin: skill.builtin,
          content: skill.content,
          files: skill.files,
        }));
      },
    },

    // ---- Catalog: delete ----
    {
      method: 'DELETE',
      pattern: '/v1/operator/skills/:name',
      name: 'DELETE /v1/operator/skills/:name',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'skill.delete', target: (ctx) => ctx.params.name }),
      ],
      handler: async ({ params, res }) => {
        let removed: boolean;
        try {
          removed = await deps.skills.remove(params.name);
        } catch (err) {
          throw httpError(409, 'skill_protected', err instanceof Error ? err.message : String(err));
        }
        if (!removed) {
          throw httpError(404, 'unknown_skill', `skill "${params.name}" not found`);
        }
        writeJson(res, 200, { ok: true });
      },
    },

    // ---- Install a registry skill onto an agent ----
    // Fetch the skill's verbatim content from the registry, then forward it
    // to the agent's /skills endpoint on its owning worker (the same write
    // path the product API uses). a8s supplies the content; the worker's
    // home is the single source of truth for what's installed.
    {
      method: 'POST',
      pattern: '/v1/operator/agents/:agentId/skills/:name',
      name: 'POST /v1/operator/agents/:id/skills/:name',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'skill.install',
          target: (ctx) => `${ctx.params.agentId}/${ctx.params.name}`,
        }),
      ],
      handler: async ({ params, res }) => {
        const skill = await deps.skills.get(params.name);
        if (!skill) {
          throw httpError(404, 'unknown_skill', `skill "${params.name}" not found`);
        }
        const entry = resolveAgentWorker(deps, params.agentId);
        const installBody = skillInstallRequestSchema.parse({
          name: skill.name,
          content: skill.content,
          files: skill.files.length ? skill.files : undefined,
        });
        const target = `${entry.callbackUrl}${A8S_PATHS.agentSkills(params.agentId)}`;
        let upstream: Response;
        try {
          upstream = await fetch(target, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
            },
            body: JSON.stringify(installBody),
          });
        } catch (err) {
          throw httpError(502, 'worker_unreachable', `worker for agent "${params.agentId}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          throw httpError(502, 'skill_install_failed', `agent "${params.agentId}" skill install HTTP ${upstream.status}: ${text.slice(0, 200)}`);
        }
        writeJson(res, 200, operatorSkillInstallResponseSchema.parse({
          ok: true,
          agentId: params.agentId,
          name: skill.name,
        }));
      },
    },
  ];
}
