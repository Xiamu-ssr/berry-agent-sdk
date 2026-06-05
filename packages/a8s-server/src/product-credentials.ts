// ============================================================
// @berry-agent/a8s-server — Product credential store
// ============================================================
// a8s is the agent platform backend; multiple products connect to it
// directly. Each product authenticates with its own bearer token, scoped to
// that product's resources. This store maps `product → token` and verifies a
// presented token back to its product.
//
// The admin token (cluster operator) is NOT here — it lives in ServerDeps and
// authenticates as the unscoped operator (full access). Product tokens are
// strictly weaker: they only ever resolve to a single product scope, never to
// operator endpoints.
//
// Persistence is intentionally pluggable (the cluster already chose its store
// via --store). Default is in-memory; a durable backing can be injected so
// product credentials survive a8s restarts.

import { randomBytes } from 'node:crypto';
import { constantTimeEqual } from './auth.js';

export interface ProductCredential {
  product: string;
  token: string;
  createdAt: number;
  label?: string;
}

/** Durable backing for product credentials. In-memory by default. */
export interface ProductCredentialBacking {
  load(): ProductCredential[];
  save(creds: ProductCredential[]): void;
}

class MemoryBacking implements ProductCredentialBacking {
  private creds: ProductCredential[] = [];
  load(): ProductCredential[] { return this.creds; }
  save(creds: ProductCredential[]): void { this.creds = creds; }
}

export class ProductCredentialStore {
  private byProduct = new Map<string, ProductCredential>();
  private readonly backing: ProductCredentialBacking;

  constructor(backing: ProductCredentialBacking = new MemoryBacking()) {
    this.backing = backing;
    for (const c of backing.load()) this.byProduct.set(c.product, c);
  }

  /** Issue (or rotate) a token for a product. Returns the new credential. */
  issue(product: string, opts: { label?: string; now?: number } = {}): ProductCredential {
    if (!product.trim()) throw new Error('product id is required');
    const cred: ProductCredential = {
      product,
      token: `bp_${randomBytes(24).toString('hex')}`,
      createdAt: opts.now ?? Date.now(),
      label: opts.label,
    };
    this.byProduct.set(product, cred);
    this.persist();
    return cred;
  }

  /** Revoke a product's credential. Returns whether one existed. */
  revoke(product: string): boolean {
    const had = this.byProduct.delete(product);
    if (had) this.persist();
    return had;
  }

  /** Resolve a presented bearer token to its product, or null. Timing-safe. */
  verify(presented: string | null | undefined): string | null {
    if (!presented) return null;
    for (const cred of this.byProduct.values()) {
      if (constantTimeEqual(presented, cred.token)) return cred.product;
    }
    return null;
  }

  /** List products (without tokens) for an operator view. */
  list(): Array<Omit<ProductCredential, 'token'>> {
    return [...this.byProduct.values()].map(({ token: _t, ...rest }) => rest);
  }

  private persist(): void {
    this.backing.save([...this.byProduct.values()]);
  }
}
