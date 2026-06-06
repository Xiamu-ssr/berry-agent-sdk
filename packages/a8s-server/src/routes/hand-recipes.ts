// ============================================================
// Routes: Hand recipes (registry + remote landing) — B4
// ============================================================
//
// The a8s side of lanxuan's option C. A machine offers only an environment
// (shell exec). The capabilities a Hand grasps are configured remotely from
// here: an operator picks a recipe from the registry and "lands" it onto a
// machine. Landing = a8s, over the exec broker it already owns, merges the
// recipe's mcpServers into the machine's .mcp.json and runs any install
// commands, then asks the connector to /reload. The new MCP server appears
// as a Hand cluster-wide on the next heartbeat (B3 path).
//
// a8s stays MCP-agnostic and secret-free: it transports the recipe fragment
// verbatim, and the recipe carries env var NAME references (`${GITHUB_TOKEN}`)
// — the value is the machine owner's asset, read from the machine's own
// environment by the MCP process. a8s never holds a secret value.

import {
  A8S_PATHS,
  MACHINE_PATHS,
  WORKER_AUTH_HEADER,
  handRecipeListResponseSchema,
  handRecipeRegisterRequestSchema,
  handRecipeLandRequestSchema,
  handRecipeLandResponseSchema,
  machineExecReplySchema,
  machineReloadReplySchema,
  workerAuthHeader,
  type HandRecipe,
} from '@berry-agent/cluster-protocol';
import type { MachineEntry } from '../machine-registry.js';
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
        try {
          const recipe = await deps.handRecipes.register(parsed);
          writeJson(res, 200, recipe);
        } catch (err) {
          throw httpError(409, 'recipe_conflict', err instanceof Error ? err.message : String(err));
        }
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
        let removed: boolean;
        try {
          removed = await deps.handRecipes.remove(params.recipeId);
        } catch (err) {
          throw httpError(409, 'recipe_protected', err instanceof Error ? err.message : String(err));
        }
        if (!removed) {
          throw httpError(404, 'unknown_recipe', `recipe "${params.recipeId}" not found`);
        }
        writeJson(res, 200, { ok: true });
      },
    },

    // ---- Land a recipe onto a machine ----
    {
      method: 'POST',
      pattern: '/v1/operator/machines/:machineId/hand-recipes/:recipeId',
      name: 'POST /v1/operator/machines/:id/hand-recipes/:id',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'hand_recipe.land',
          target: (ctx) => `${ctx.params.machineId}/${ctx.params.recipeId}`,
        }),
      ],
      handler: async ({ params, req, res }) => {
        const recipe = await deps.handRecipes.get(params.recipeId);
        if (!recipe) {
          throw httpError(404, 'unknown_recipe', `recipe "${params.recipeId}" not found`);
        }
        const entry = deps.machines.get(params.machineId);
        if (!entry) {
          throw httpError(404, 'unknown_machine', `machine "${params.machineId}" is not registered`);
        }
        if (deps.machines.stateOf(entry, Date.now()) !== 'active') {
          throw httpError(409, 'machine_unavailable', `machine "${params.machineId}" is not active (no recent heartbeat)`);
        }
        const body = handRecipeLandRequestSchema.parse(await readJsonBody(req));
        const configPath = body.configPath ?? entry.mcpConfigPath;
        if (!configPath) {
          throw httpError(409, 'no_mcp_config_path',
            `machine "${params.machineId}" did not report an .mcp.json path; pass configPath in the body or re-register the connector with MCP enabled`);
        }

        // 1) Merge the recipe's mcpServers into the machine's .mcp.json.
        await landConfig(entry, configPath, recipe);
        // 2) Run any install commands (e.g. npm i -g) on the machine.
        for (const cmd of recipe.installCommands) {
          await execOnMachine(entry, cmd, dirOf(configPath));
        }
        // 3) Ask the connector to rescan + rebuild live MCP connections.
        const reload = await reloadMachine(entry);

        writeJson(res, 200, handRecipeLandResponseSchema.parse({
          machineId: entry.machineId,
          recipeId: recipe.id,
          configPath,
          mcpServers: reload.mcpServers,
          mcpManifest: reload.mcpManifest,
        }));
      },
    },
  ];
}

/** Parent directory of a path, for use as exec cwd. */
function dirOf(path: string): string {
  const idx = path.replace(/\/+$/, '').lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Read the machine's current .mcp.json (empty if absent), merge the recipe's
 * mcpServers in, and write it back — all over the exec broker. We base64 the
 * JSON so arbitrary content survives the shell round-trip without quoting
 * hazards. a8s does the merge in-process (it holds the recipe); the machine
 * only decodes + writes.
 */
async function landConfig(entry: MachineEntry, configPath: string, recipe: HandRecipe): Promise<void> {
  const dir = dirOf(configPath);
  // Read current config base64-encoded so the round-trip is exact (no shell
  // whitespace/sentinel ambiguity). Missing file → empty string. The
  // connector's executor substitutes "(no output)" for empty stdout, so we
  // emit a stable marker and strip it.
  const catReply = await execOnMachine(
    entry,
    `if [ -f ${shq(configPath)} ]; then base64 < ${shq(configPath)}; fi; echo __BERRY_EOF__`,
    dir,
  );
  const b64in = catReply.output.split('__BERRY_EOF__')[0].replace(/\s+/g, '');
  let current: { mcpServers?: Record<string, unknown> } = {};
  if (b64in) {
    let text = '';
    try {
      text = Buffer.from(b64in, 'base64').toString('utf-8');
    } catch {
      throw httpError(409, 'mcp_config_unparsable',
        `could not decode machine's ${configPath}; refusing to overwrite`);
    }
    try {
      current = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    } catch {
      // Corrupt/non-JSON file: don't clobber blindly — fail loudly.
      throw httpError(409, 'mcp_config_unparsable',
        `machine's ${configPath} is not valid JSON; refusing to overwrite`);
    }
  }
  const merged = {
    ...current,
    mcpServers: { ...(current.mcpServers ?? {}), ...recipe.mcpServers },
  };
  const json = JSON.stringify(merged, null, 2) + '\n';
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  // mkdir -p so a fresh machine without the dir still works; decode+write.
  await execOnMachine(
    entry,
    `mkdir -p ${shq(dir)} && printf %s ${shq(b64)} | base64 -d > ${shq(configPath)}`,
    dir,
  );
}

/** One-quote shell escaping for embedding a value as a single arg. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a command on the machine via the exec broker; throws on transport/exec error. */
async function execOnMachine(entry: MachineEntry, command: string, cwd: string) {
  const target = `${entry.callbackUrl.replace(/\/$/, '')}${MACHINE_PATHS.exec}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token),
      },
      body: JSON.stringify({ command, cwd, env: {} }),
    });
  } catch (err) {
    throw httpError(502, 'machine_unreachable', `machine "${entry.machineId}" unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw httpError(502, 'machine_exec_failed', `machine "${entry.machineId}" exec HTTP ${upstream.status}: ${t.slice(0, 200)}`);
  }
  const reply = machineExecReplySchema.parse(await upstream.json());
  if (reply.isError) {
    throw httpError(502, 'machine_exec_failed', `command failed on "${entry.machineId}": ${reply.output.slice(0, 300)}`);
  }
  return reply;
}

/** POST /reload to the connector and return its fresh MCP capability. */
async function reloadMachine(entry: MachineEntry) {
  const target = `${entry.callbackUrl.replace(/\/$/, '')}${MACHINE_PATHS.reload}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { [WORKER_AUTH_HEADER]: workerAuthHeader(entry.token) },
    });
  } catch (err) {
    throw httpError(502, 'machine_unreachable', `machine "${entry.machineId}" unreachable for reload: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw httpError(502, 'machine_reload_failed', `machine "${entry.machineId}" reload HTTP ${upstream.status}: ${t.slice(0, 200)}`);
  }
  return machineReloadReplySchema.parse(await upstream.json());
}
