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
import { listBuiltinPresets, listModels, getPreset, modelProtocolFamily, RAW_PRESET_ID } from '@berry-agent/models';
import { readJsonBody, writeJson } from '../http-helpers.js';
import type { RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken, requireProductScope } from '../auth.js';
import { withAudit } from '../middleware.js';

export function modelsRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: A8S_PATHS.catalogModelsTemplate,
      name: 'GET /v1/catalog/models-template',
      middleware: [requireProductScope(deps)],
      handler: async ({ res }) => {
        const record = await deps.modelsTemplate.get();
        writeJson(res, 200, modelsTemplateGetResponseSchema.parse({
          template: record?.template ? withModelFamilies(record.template) : null,
          updatedAt: record?.updatedAt ?? null,
        }));
      },
    },
    {
      method: 'PUT',
      pattern: A8S_PATHS.catalogModelsTemplate,
      name: 'PUT /v1/catalog/models-template',
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
      pattern: A8S_PATHS.catalogModelsPresets,
      name: 'GET /v1/catalog/models/presets',
      middleware: [requireAdminToken(deps)],
      handler: ({ res }) => {
        const presets = listBuiltinPresets().map((p) => ({
          id: p.id,
          label: p.name,
          endpoints: p.endpoints,
          protocols: (['anthropic', 'openai'] as const).filter((k) => p.endpoints[k]),
          canList: !!p.listModelsPath,
          apiKeyDocsUrl: p.apiKeyDocsUrl,
        }));
        writeJson(res, 200, modelsPresetListResponseSchema.parse({ presets }));
      },
    },
    {
      method: 'POST',
      pattern: A8S_PATHS.catalogModelsProbe,
      name: 'POST /v1/catalog/models/probe',
      // No audit: probing is read-only and the body carries a secret we
      // don't want in the audit log.
      middleware: [requireAdminToken(deps)],
      handler: async ({ req, res }) => {
        const { presetId, protocol, baseUrl, apiKey } = modelsProbeRequestSchema.parse(await readJsonBody(req));
        // Build a ProviderInstance for listModels. With a known preset we
        // inherit its listModelsPath/endpoints/auth; without one we go raw and
        // rely on the given baseUrl for the chosen protocol (openai default).
        const preset = presetId ? getPreset(presetId) : undefined;
        const probeProtocol = protocol ?? (preset?.endpoints.anthropic ? 'anthropic' : 'openai');
        const endpoints = baseUrl
          ? { [probeProtocol]: baseUrl }
          : preset?.endpoints;
        const result = await listModels(
          {
            id: 'probe',
            presetId: preset ? preset.id : RAW_PRESET_ID,
            apiKey,
            endpoints,
            knownModels: [],
          } as Parameters<typeof listModels>[0],
          { protocol: probeProtocol, timeoutMs: 12_000 },
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

/**
 * Enrich each model in the template with its inferred protocol `family`
 * (anthropic/openai), computed server-side from @berry-agent/models so the UI
 * never re-implements the family regex (single source of truth). Passthrough
 * keeps the wire schema happy; the UI reads `models[id].family`.
 */
function withModelFamilies(template: {
  providers: Record<string, unknown>;
  models: Record<string, { providers?: Array<{ remoteModelId?: string }> }>;
  tiers: Record<string, string>;
}): typeof template {
  const models = Object.fromEntries(
    Object.entries(template.models).map(([id, m]) => {
      const remoteId = m.providers?.[0]?.remoteModelId;
      return [id, { ...m, family: modelProtocolFamily(id, remoteId) }];
    }),
  );
  return { ...template, models };
}