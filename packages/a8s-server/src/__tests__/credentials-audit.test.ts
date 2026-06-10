// ============================================================
// Routes: product-credentials + audit (HTTP) — 甲2 P3
// ============================================================
// Spins up a real A8sServer (admin-token guarded, temp auditRoot) and drives
// the new operator endpoints over HTTP: issue/list/revoke credentials, and
// query the audit log (which those mutations themselves populate).

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  A8S_PATHS,
  productCredentialListResponseSchema,
  productCredentialIssueResponseSchema,
  scopedTokenIssueResponseSchema,
  auditQueryResponseSchema,
} from '@berry-agent/cluster-protocol';
import { MemoryRuntimeOrchestrationStore, RuntimeOrchestrator } from '@berry-agent/runtime';
import { A8sServer } from '../server.js';

const ADMIN = 'admin-secret';

async function pickPort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

describe('product-credentials + audit routes', () => {
  let a8s: A8sServer<unknown>;
  let url: string;
  const auth = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };

  beforeAll(async () => {
    const orchestrator = new RuntimeOrchestrator({ store: new MemoryRuntimeOrchestrationStore() });
    const port = await pickPort();
    a8s = new A8sServer({
      port,
      controlPlane: { orchestrator },
      adminToken: ADMIN,
      auditRoot: mkdtempSync(join(tmpdir(), 'a8s-audit-')),
    });
    const info = await a8s.start();
    url = info.url;
  });

  afterAll(async () => { await a8s.stop(); });

  it('credentials: requires admin token', async () => {
    const r = await fetch(`${url}${A8S_PATHS.operatorCredentials}`);
    expect(r.status).toBe(401);
  });

  it('credentials: issue returns the token once, list omits it, revoke removes it', async () => {
    // issue
    const issued = await fetch(`${url}${A8S_PATHS.operatorCredentials}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ product: 'claw', label: 'demo' }),
    });
    expect(issued.status).toBe(200);
    const cred = productCredentialIssueResponseSchema.parse(await issued.json());
    expect(cred.product).toBe('claw');
    expect(cred.token.startsWith('bp_')).toBe(true);

    // list — metadata only, no token field
    const listed = await fetch(`${url}${A8S_PATHS.operatorCredentials}`, { headers: auth });
    const { credentials } = productCredentialListResponseSchema.parse(await listed.json());
    const row = credentials.find((c) => c.product === 'claw');
    expect(row).toBeTruthy();
    expect(row!.label).toBe('demo');
    expect((row as Record<string, unknown>).token).toBeUndefined();

    // revoke
    const revoked = await fetch(`${url}${A8S_PATHS.operatorCredential('claw')}`, { method: 'DELETE', headers: auth });
    expect(revoked.status).toBe(200);
    // revoking again → 404
    const again = await fetch(`${url}${A8S_PATHS.operatorCredential('claw')}`, { method: 'DELETE', headers: auth });
    expect(again.status).toBe(404);
  });

  it('credentials: rejects a non-kebab product id (zod 400)', async () => {
    const r = await fetch(`${url}${A8S_PATHS.operatorCredentials}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ product: 'Not Kebab' }),
    });
    expect(r.status).toBe(400);
  });

  it('scoped-token: product root token mints a subject token; subject token cannot re-mint', async () => {
    // Issue a fresh product root token (admin).
    const issued = await fetch(`${url}${A8S_PATHS.operatorCredentials}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ product: 'shop' }),
    });
    const root = productCredentialIssueResponseSchema.parse(await issued.json());

    // Root token mints a subject-scoped token.
    const mintWithRoot = await fetch(`${url}${A8S_PATHS.productScopedToken('shop')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${root.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'alice' }),
    });
    expect(mintWithRoot.status).toBe(200);
    const scopedResp = scopedTokenIssueResponseSchema.parse(await mintWithRoot.json());
    expect(scopedResp.product).toBe('shop');
    expect(scopedResp.subject).toBe('alice');
    expect(scopedResp.token.startsWith('bs_')).toBe(true);

    // The subject token must NOT be able to mint (no privilege escalation).
    const escalate = await fetch(`${url}${A8S_PATHS.productScopedToken('shop')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${scopedResp.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });
    expect(escalate.status).toBe(401);

    // A root token cannot mint under a DIFFERENT product.
    const crossProduct = await fetch(`${url}${A8S_PATHS.productScopedToken('other')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${root.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'alice' }),
    });
    expect(crossProduct.status).toBe(401);

    // Admin may mint for any product.
    const mintWithAdmin = await fetch(`${url}${A8S_PATHS.productScopedToken('shop')}`, {
      method: 'POST', headers: auth, body: JSON.stringify({ subject: 'carol' }),
    });
    expect(mintWithAdmin.status).toBe(200);

    // No token at all → 401.
    const anon = await fetch(`${url}${A8S_PATHS.productScopedToken('shop')}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'x' }),
    });
    expect(anon.status).toBe(401);
  });

  it('audit: the credential mutations above were recorded and are queryable', async () => {
    // The issue + revoke above ran through withAudit, so entries should exist.
    const r = await fetch(`${url}${A8S_PATHS.operatorAudit}`, { headers: auth });
    expect(r.status).toBe(200);
    const { entries } = auditQueryResponseSchema.parse(await r.json());
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('credential.issue');
    expect(actions).toContain('credential.revoke');
    // newest-first ordering
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].ts).toBeGreaterThanOrEqual(entries[i].ts);
    }
  });

  it('audit: filters by action', async () => {
    const r = await fetch(`${url}${A8S_PATHS.operatorAudit}?action=credential.revoke`, { headers: auth });
    const { entries } = auditQueryResponseSchema.parse(await r.json());
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.action === 'credential.revoke')).toBe(true);
  });

  it('audit: requires admin token', async () => {
    const r = await fetch(`${url}${A8S_PATHS.operatorAudit}`);
    expect(r.status).toBe(401);
  });
});
