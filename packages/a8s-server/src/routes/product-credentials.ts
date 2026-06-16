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
  ADMIN_AUTH_HEADER,
  parseAdminAuthHeader,
  productCredentialListResponseSchema,
  productCredentialIssueRequestSchema,
  productCredentialIssueResponseSchema,
  scopedTokenIssueRequestSchema,
  scopedTokenIssueResponseSchema,
  scopedTokenListResponseSchema,
} from '@berry-agent/cluster-protocol';
import { readJsonBody, writeJson } from '../http-helpers.js';
import { httpError, type RouteDefinition } from '../router.js';
import type { ServerDeps } from '../deps.js';
import { constantTimeEqual, requireAdminToken } from '../auth.js';
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

    // ---- List subject tokens for a product (metadata, no token values) ----
    {
      method: 'GET',
      pattern: '/v1/operator/credentials/:product/scoped-tokens',
      name: 'GET /v1/operator/credentials/:product/scoped-tokens',
      middleware: [requireAdminToken(deps)],
      handler: async ({ params, res }) => {
        const tokens = deps.productCredentials.listScoped(params.product);
        writeJson(res, 200, scopedTokenListResponseSchema.parse({ tokens }));
      },
    },

    // ---- Revoke a single subject token ----
    {
      method: 'DELETE',
      pattern: '/v1/operator/credentials/:product/scoped-tokens/:subject',
      name: 'DELETE /v1/operator/credentials/:product/scoped-tokens/:subject',
      middleware: [
        requireAdminToken(deps),
        withAudit(deps.audit, { action: 'credential.scoped.revoke', target: (ctx) => `${ctx.params.product}/${ctx.params.subject}` }),
      ],
      handler: async ({ params, res }) => {
        const removed = deps.productCredentials.revokeSubject(params.product, params.subject);
        if (!removed) {
          throw httpError(404, 'unknown_subject', `no scoped token for "${params.product}/${params.subject}"`);
        }
        writeJson(res, 200, { ok: true });
      },
    },

    // ---- Mint a subject-scoped token under a product ----
    // Auth: the caller must present THIS product's root token (so a product
    // backend mints sub-tokens for its own users) or the cluster admin token.
    // A subject-scoped token may NOT mint (no privilege escalation), and a
    // product's root token may not mint under a different product.
    {
      method: 'POST',
      pattern: '/v1/products/:product/scoped-token',
      name: 'POST /v1/products/:product/scoped-token',
      middleware: [
        withAudit(deps.audit, { action: 'credential.scoped.issue', target: (ctx) => ctx.params.product }),
      ],
      handler: async ({ params, req, res }) => {
        const presented = parseAdminAuthHeader(
          req.headers[ADMIN_AUTH_HEADER.toLowerCase()] as string | undefined,
        );
        const isAdmin = !!deps.adminToken && !!presented && constantTimeEqual(presented, deps.adminToken);
        if (!isAdmin) {
          const resolved = deps.productCredentials.verify(presented);
          // Only this product's ROOT token (no subject) may mint for it.
          if (!resolved || resolved.subject !== undefined || resolved.product !== params.product) {
            throw httpError(401, 'unauthorized', 'requires this product\'s root token or the admin token');
          }
        }
        const parsed = scopedTokenIssueRequestSchema.parse(await readJsonBody(req));
        const cred = deps.productCredentials.issueScoped(params.product, parsed.subject, { label: parsed.label });
        // The ONE time the token is returned — the product backend must hand it
        // to the user's browser now (and keep its own root token server-side).
        writeJson(res, 200, scopedTokenIssueResponseSchema.parse({
          product: cred.product,
          subject: cred.subject,
          token: cred.token,
          createdAt: cred.createdAt,
          label: cred.label,
        }));
      },
    },
  ];
}
