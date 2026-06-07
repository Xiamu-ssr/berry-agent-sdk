// ============================================================
// Routes: Hand recipes (registry)
// ============================================================
//
// A Hand recipe is a market entry: an environment (machine) + a referenced
// subset of the MCP servers that machine exposes. The recipe carries NO MCP
// config — the machine's `.mcp.json` is the single source of truth, authored
// on the Machines page. So this registry is pure CRUD; there is no "land" step.
//
// Selecting a Hand onto an agent grants its machine (the agent gets
// `machine_<id>_exec` and reaches the machine's MCP via berry-mcp). Provisioning
// the MCP a Hand references is a separate machine-level operation.

import {
  A8S_PATHS,
  handRecipeListResponseSchema,
  handRecipeRegisterRequestSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function handRecipeRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- Registry: list ----
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorHandRecipes,
      name: 'GET /v1/operator/hand-recipes',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const recipes = await deps.handRecipes.list();
        writeJson(res, 200, handRecipeListResponseSchema.parse({ recipes }));
      },
    },

    // ---- Registry: register/update ----
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorHandRecipes,
      name: 'POST /v1/operator/hand-recipes',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'hand_recipe.register', target: (ctx) => ctx.params.recipeId ?? '' }),
      ],
      handler: async ({ req, res }) => {
        const parsed = handRecipeRegisterRequestSchema.parse(await readJsonBody(req));
        const recipe = await deps.handRecipes.register(parsed);
        writeJson(res, 200, recipe);
      },
    },

    // ---- Registry: delete ----
    {
      method: 'DELETE',
      pattern: '/v1/operator/hand-recipes/:recipeId',
      name: 'DELETE /v1/operator/hand-recipes/:id',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'hand_recipe.delete', target: (ctx) => ctx.params.recipeId }),
      ],
      handler: async ({ params, res }) => {
        const removed = await deps.handRecipes.remove(params.recipeId);
        if (!removed) {
          throw httpError(404, 'unknown_recipe', `recipe "${params.recipeId}" not found`);
        }
        writeJson(res, 200, { ok: true });
      },
    },
  ];
}
