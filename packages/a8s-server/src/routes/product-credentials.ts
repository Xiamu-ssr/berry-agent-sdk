// ============================================================
// Routes: Product credentials (issue/revoke/list) — 甲2 P3
// ============================================================
//
// a8s is multi-tenant: each product authenticates with a `bp_…` bearer token
// scoped to its own agents (see product-credentials.ts). These operator routes
// let the cluster admin issue/rotate, revoke, and list those credentials.
//
// The token VALUE is returned only at issue time — the list route returns
// metadata without it (the store doesn't surface tokens for listing). The
// operator must copy the token when issuing; rotating issues a fresh one.

import {
  A8S_PATHS,
  productCredentialListResponseSchema,
  productCredentialIssueRequestSchema,
  productCredentialIssueResponseSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { requireAdminToken } from '../auth.js';
import { withAudit } from '../middleware.js';

export function productCredentialRoutes<TEntry>(deps: ServerDeps<TEntry>): RouteDefinition[] {
  return [
    // ---- List (metadata only, no token values) ----
    {
      method: 'GET',
      pattern: A8S_PATHS.operatorCredentials,
      name: 'GET /v1/operator/credentials',
      middleware: [requireAdminToken(deps)],
      handler: async ({ res }) => {
        const credentials = deps.productCredentials.list();
        writeJson(res, 200, productCredentialListResponseSchema.parse({ credentials }));
      },
    },

    // ---- Issue / rotate ----
    {
      method: 'POST',
      pattern: A8S_PATHS.operatorCredentials,
      name: 'POST /v1/operator/credentials',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, {
          action: 'credential.issue',
          // body isn't parsed yet at audit time — record nothing sensitive.
        }),
      ],
      handler: async ({ req, res }) => {
        const parsed = productCredentialIssueRequestSchema.parse(await readJsonBody(req));
        const cred = deps.productCredentials.issue(parsed.product, { label: parsed.label });
        // The ONE time the token is returned — operator must copy it now.
        writeJson(res, 200, productCredentialIssueResponseSchema.parse({
          product: cred.product,
          token: cred.token,
          createdAt: cred.createdAt,
          label: cred.label,
        }));
      },
    },

    // ---- Revoke ----
    {
      method: 'DELETE',
      pattern: '/v1/operator/credentials/:product',
      name: 'DELETE /v1/operator/credentials/:product',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'credential.revoke', target: (ctx) => ctx.params.product }),
      ],
      handler: async ({ params, res }) => {
        const had = deps.productCredentials.revoke(params.product);
        if (!had) {
          throw httpError(404, 'unknown_product', `no credential for product "${params.product}"`);
        }
        writeJson(res, 200, { ok: true });
      },
    },
  ];
}
