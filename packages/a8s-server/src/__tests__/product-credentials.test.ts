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
    expect(store.verify(a.token)).toBe('claw');
    expect(store.verify(b.token)).toBe('other');
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
    expect(store.verify(second.token)).toBe('claw');
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
    expect(reopened.verify(c.token)).toBe('claw');
  });
});

describe('scopeCanAccess', () => {
  it('operator scope accesses anything', () => {
    expect(scopeCanAccess('*', 'claw')).toBe(true);
    expect(scopeCanAccess('*', undefined)).toBe(true);
  });
  it('product scope accesses only its own owned resources', () => {
    expect(scopeCanAccess({ product: 'claw' }, 'claw')).toBe(true);
    expect(scopeCanAccess({ product: 'claw' }, 'other')).toBe(false);
    // Unowned (legacy) resource is operator-only.
    expect(scopeCanAccess({ product: 'claw' }, undefined)).toBe(false);
  });
  it('absent scope accesses nothing', () => {
    expect(scopeCanAccess(undefined, 'claw')).toBe(false);
  });
});
