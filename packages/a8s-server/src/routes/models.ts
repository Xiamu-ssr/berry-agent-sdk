// ============================================================
// Routes: models template
// ============================================================
//
// Operator-scoped CRUD for the cluster-wide LLM models template.
// GET returns the current template (or null if unset); PUT replaces it
// (validated by zod). Workers separately fetch this same template
// during register when their local registry is null — see the worker
// register handler.

import {
  A8S_PATHS,
  modelsTemplateGetResponseSchema,
  modelsTemplatePutRequestSchema,
  operatorOkResponseSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function modelsRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorModelsTemplate,
      name: 'GET /v1/operator/models-template',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const record = await deps.modelsTemplate.get();
        writeJson(res, 200, modelsTemplateGetResponseSchema.parse({
          template: record?.template ?? null,
          updatedAt: record?.updatedAt ?? null,
        }));
      },
    },
    {
      method: 'PUT',
      pattern: A8S_PATHS.operatorModelsTemplate,
      name: 'PUT /v1/operator/models-template',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'models.template_put' }),
      ],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req);
        const parsed = modelsTemplatePutRequestSchema.parse(body);
        await deps.modelsTemplate.put(parsed.template);
        writeJson(res, 200, operatorOkResponseSchema.parse({ ok: true }));
      },
    },
  ];
}