// ============================================================
// Routes: models template + provider probe/presets
// ============================================================
//
// Operator-scoped LLM config surface:
//   - GET/PUT /v1/operator/models-template  — the cluster-wide template
//     workers pull at register.
//   - GET  /v1/operator/models/presets      — built-in provider presets
//     for the UI's "add provider" dropdown.
//   - POST /v1/operator/models/probe        — proxy a provider's model
//     list so the operator picks real model ids (key never hits the
//     browser, and the probe persists nothing).

import {
  A8S_PATHS,
  modelsPresetListResponseSchema,
  modelsProbeRequestSchema,
  modelsProbeResponseSchema,
  modelsTemplateGetResponseSchema,
  modelsTemplatePutRequestSchema,
  operatorOkResponseSchema,
} from '@berry-agent/cluster-protocol';
import { listBuiltinPresets, listModels, getPreset, RAW_PRESET_ID } from '@berry-agent/models';
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
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorModelsPresets,
      name: 'GET /v1/operator/models/presets',
      middleware: [requireAdminToken(deps)],
      handler: ({ res }) => {
        const presets = listBuiltinPresets().map((p) => ({
          id: p.id,
          label: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          canList: !!p.listModelsPath,
          apiKeyDocsUrl: p.apiKeyDocsUrl,
        }));
        writeJson(res, 200, modelsPresetListResponseSchema.parse({ presets }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorModelsProbe,
      name: 'POST /v1/operator/models/probe',
      // No audit: probing is read-only and the body carries a secret we
      // don't want in the audit log.
      middleware: [requireAdminToken(deps)],
      handler: async ({ req, res }) => {
        const { presetId, baseUrl, apiKey, type } = modelsProbeRequestSchema.parse(await readJsonBody(req));
        // Build a ProviderInstance for listModels. With a known preset we
        // inherit its listModelsPath/baseUrl/auth; without one we go raw
        // and rely on the given baseUrl (+ openai-style auth by default).
        const preset = presetId ? getPreset(presetId) : undefined;
        const result = await listModels(
          {
            id: 'probe',
            presetId: preset ? preset.id : RAW_PRESET_ID,
            apiKey,
            baseUrl: baseUrl ?? preset?.baseUrl ?? '',
            knownModels: [],
            type: type ?? preset?.type ?? 'openai',
          } as Parameters<typeof listModels>[0],
          { timeoutMs: 12_000 },
        );
        writeJson(res, 200, modelsProbeResponseSchema.parse({
          models: result.models,
          source: result.source,
          warning: result.warning,
        }));
      },
    },
  ];
}