// ============================================================
// @berry-agent/a8s-server — product credentials + scope tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { ProductCredentialStore } from '../product-credentials.js';
import { scopeCanAccess } from '../auth.js';

describe('ProductCredentialStore', () => {
  it('issues a unique token per product and verifies it back', () => {
    const store = new ProductCredentialStore();
    const a = store.issue('claw', { now: 1 });
    const b = store.issue('other', { now: 2 });
    expect(a.token).not.toBe(b.token);
    expect(a.token.startsWith('bp_')).toBe(true);
    expect(store.verify(a.token)).toEqual({ product: 'claw' });
    expect(store.verify(b.token)).toEqual({ product: 'other' });
  });

  it('returns null for unknown / empty tokens', () => {
    const store = new ProductCredentialStore();
    store.issue('claw');
    expect(store.verify('bp_nope')).toBeNull();
    expect(store.verify('')).toBeNull();
    expect(store.verify(null)).toBeNull();
    expect(store.verify(undefined)).toBeNull();
  });

  it('rotating a product replaces its token (old token stops working)', () => {
    const store = new ProductCredentialStore();
    const first = store.issue('claw');
    const second = store.issue('claw');
    expect(store.verify(first.token)).toBeNull();
    expect(store.verify(second.token)).toEqual({ product: 'claw' });
  });

  it('revoke removes the credential', () => {
    const store = new ProductCredentialStore();
    const c = store.issue('claw');
    expect(store.revoke('claw')).toBe(true);
    expect(store.verify(c.token)).toBeNull();
    expect(store.revoke('claw')).toBe(false);
  });

  it('list omits tokens', () => {
    const store = new ProductCredentialStore();
    store.issue('claw', { label: 'Berry Claw' });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ product: 'claw', label: 'Berry Claw' });
    expect('token' in list[0]).toBe(false);
  });

  it('persists through an injected backing', () => {
    const saved: unknown[] = [];
    const backing = {
      load: () => saved as never,
      save: (creds: unknown[]) => { saved.length = 0; saved.push(...creds); },
    };
    const store = new ProductCredentialStore(backing);
    const c = store.issue('claw');
    // A fresh store over the same backing sees the issued credential.
    const reopened = new ProductCredentialStore(backing);
    expect(reopened.verify(c.token)).toEqual({ product: 'claw' });
  });
});

describe('ProductCredentialStore — subject-scoped tokens', () => {
  it('mints a bs_ sub-token that resolves to product:subject', () => {
    const store = new ProductCredentialStore();
    store.issue('claw');
    const sub = store.issueScoped('claw', 'user-1', { now: 5 });
    expect(sub.token.startsWith('bs_')).toBe(true);
    expect(store.verify(sub.token)).toEqual({ product: 'claw', subject: 'user-1' });
  });

  it('subject tokens are distinct per subject and rotate on re-mint', () => {
    const store = new ProductCredentialStore();
    const u1 = store.issueScoped('claw', 'user-1');
    const u2 = store.issueScoped('claw', 'user-2');
    expect(u1.token).not.toBe(u2.token);
    // Re-minting user-1 invalidates the prior token.
    const u1b = store.issueScoped('claw', 'user-1');
    expect(store.verify(u1.token)).toBeNull();
    expect(store.verify(u1b.token)).toEqual({ product: 'claw', subject: 'user-1' });
    // user-2 untouched.
    expect(store.verify(u2.token)).toEqual({ product: 'claw', subject: 'user-2' });
  });

  it('revoking a product cascades to all its subject tokens', () => {
    const store = new ProductCredentialStore();
    const root = store.issue('claw');
    const u1 = store.issueScoped('claw', 'user-1');
    const u2 = store.issueScoped('claw', 'user-2');
    store.revoke('claw');
    expect(store.verify(root.token)).toBeNull();
    expect(store.verify(u1.token)).toBeNull();
    expect(store.verify(u2.token)).toBeNull();
  });

  it('revokeSubject removes one user without touching others', () => {
    const store = new ProductCredentialStore();
    const u1 = store.issueScoped('claw', 'user-1');
    const u2 = store.issueScoped('claw', 'user-2');
    expect(store.revokeSubject('claw', 'user-1')).toBe(true);
    expect(store.verify(u1.token)).toBeNull();
    expect(store.verify(u2.token)).toEqual({ product: 'claw', subject: 'user-2' });
    expect(store.revokeSubject('claw', 'user-1')).toBe(false);
  });

  it('list omits subject sub-tokens (root credentials only)', () => {
    const store = new ProductCredentialStore();
    store.issue('claw');
    store.issueScoped('claw', 'user-1');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ product: 'claw' });
  });

  it('persists subject tokens through a backing', () => {
    const saved: unknown[] = [];
    const backing = {
      load: () => saved as never,
      save: (creds: unknown[]) => { saved.length = 0; saved.push(...creds); },
    };
    const store = new ProductCredentialStore(backing);
    store.issue('claw');
    const sub = store.issueScoped('claw', 'user-1');
    const reopened = new ProductCredentialStore(backing);
    expect(reopened.verify(sub.token)).toEqual({ product: 'claw', subject: 'user-1' });
  });
});

describe('scopeCanAccess', () => {
  it('operator scope accesses anything', () => {
    expect(scopeCanAccess('*', 'claw')).toBe(true);
    expect(scopeCanAccess('*', undefined)).toBe(true);
  });
  it('product root scope accesses bare-product AND all its subjects', () => {
    expect(scopeCanAccess({ product: 'claw' }, 'claw')).toBe(true);
    expect(scopeCanAccess({ product: 'claw' }, 'claw:user-1')).toBe(true);
    expect(scopeCanAccess({ product: 'claw' }, 'claw:user-2')).toBe(true);
    expect(scopeCanAccess({ product: 'claw' }, 'other')).toBe(false);
    // A product whose name is a prefix of another must not leak across.
    expect(scopeCanAccess({ product: 'claw' }, 'clawful')).toBe(false);
    expect(scopeCanAccess({ product: 'claw' }, undefined)).toBe(false);
  });
  it('subject scope accesses ONLY its own product:subject', () => {
    expect(scopeCanAccess({ product: 'claw', subject: 'user-1' }, 'claw:user-1')).toBe(true);
    expect(scopeCanAccess({ product: 'claw', subject: 'user-1' }, 'claw:user-2')).toBe(false);
    // A subject token cannot see the product's bare-owned (cross-user) resources.
    expect(scopeCanAccess({ product: 'claw', subject: 'user-1' }, 'claw')).toBe(false);
    expect(scopeCanAccess({ product: 'claw', subject: 'user-1' }, 'other:user-1')).toBe(false);
  });
  it('absent scope accesses nothing', () => {
    expect(scopeCanAccess(undefined, 'claw')).toBe(false);
  });
});
