// ============================================================
// @berry-agent/a8s-server — Product credential store
// ============================================================
// a8s is the agent platform backend; multiple products connect to it
// directly. Each product authenticates with its own bearer token, scoped to
// that product's resources. This store maps `product → token` and verifies a
// presented token back to its product.
//
// SUBJECT-SCOPED TOKENS: a8s does NOT model "users". A product (e.g.
// berry-claw) decides who its end-users are and how they log in. But the token
// a product hands to one of its users is signed + verified HERE: the product's
// root token mints a narrower token bound to an opaque `subject` string, and
// that token only ever resolves to owner `product:subject`. The product
// backend mints one per logged-in user and never leaks its root token to a
// browser. `subject` is opaque to a8s — its meaning is the product's business.
//
// The admin token (cluster operator) is NOT here — it lives in ServerDeps and
// authenticates as the unscoped operator (full access). Product tokens are
// strictly weaker: a root token resolves to one product; a subject token to
// one product:subject. Neither ever reaches operator endpoints.
//
// Persistence is intentionally pluggable (the cluster already chose its store
// via --store). Default is in-memory; a durable backing can be injected so
// product credentials survive a8s restarts.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { constantTimeEqual } from './auth.js';

export interface ProductCredential {
  product: string;
  /** undefined = root product token; set = a subject-scoped sub-token. */
  subject?: string;
  token: string;
  createdAt: number;
  label?: string;
}

/** What a verified token resolves to: a product, optionally narrowed to a subject. */
export interface ResolvedScope {
  product: string;
  subject?: string;
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

export class FileCredentialBacking implements ProductCredentialBacking {
  constructor(private readonly filePath: string) {}

  load(): ProductCredential[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  save(creds: ProductCredential[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(creds, null, 2));
    renameSync(tmp, this.filePath);
  }
}

export class ProductCredentialStore {
  /** Root credentials — one per product, rotatable. */
  private byProduct = new Map<string, ProductCredential>();
  /** Subject-scoped sub-tokens, keyed by token value. Many per product. */
  private scoped = new Map<string, ProductCredential>();
  private readonly backing: ProductCredentialBacking;

  constructor(backing: ProductCredentialBacking = new MemoryBacking()) {
    this.backing = backing;
    for (const c of backing.load()) {
      if (c.subject === undefined) this.byProduct.set(c.product, c);
      else this.scoped.set(c.token, c);
    }
  }

  /** Issue (or rotate) a root token for a product. Returns the new credential. */
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

  /**
   * Mint a subject-scoped sub-token under a product. The token resolves to
   * `{ product, subject }` and never to the whole product. Re-minting for the
   * same (product, subject) rotates it (drops the previous one).
   */
  issueScoped(product: string, subject: string, opts: { label?: string; now?: number } = {}): ProductCredential {
    if (!product.trim()) throw new Error('product id is required');
    if (!subject.trim()) throw new Error('subject is required');
    // Drop any prior token for this exact (product, subject) so re-mint rotates.
    for (const [tok, c] of this.scoped) {
      if (c.product === product && c.subject === subject) this.scoped.delete(tok);
    }
    const cred: ProductCredential = {
      product,
      subject,
      token: `bs_${randomBytes(24).toString('hex')}`,
      createdAt: opts.now ?? Date.now(),
      label: opts.label,
    };
    this.scoped.set(cred.token, cred);
    this.persist();
    return cred;
  }

  /** Revoke a product's root token AND all its subject sub-tokens (cascade). */
  revoke(product: string): boolean {
    const had = this.byProduct.delete(product);
    let removedScoped = false;
    for (const [tok, c] of this.scoped) {
      if (c.product === product) { this.scoped.delete(tok); removedScoped = true; }
    }
    if (had || removedScoped) this.persist();
    return had;
  }

  /** Revoke a single subject sub-token (e.g. one user logs out / is banned). */
  revokeSubject(product: string, subject: string): boolean {
    let removed = false;
    for (const [tok, c] of this.scoped) {
      if (c.product === product && c.subject === subject) { this.scoped.delete(tok); removed = true; }
    }
    if (removed) this.persist();
    return removed;
  }

  /**
   * Resolve a presented bearer token to its scope, or null. Timing-safe over
   * both root and subject tokens.
   */
  verify(presented: string | null | undefined): ResolvedScope | null {
    if (!presented) return null;
    for (const cred of this.byProduct.values()) {
      if (constantTimeEqual(presented, cred.token)) return { product: cred.product };
    }
    for (const cred of this.scoped.values()) {
      if (constantTimeEqual(presented, cred.token)) return { product: cred.product, subject: cred.subject };
    }
    return null;
  }

  /** List products (root credentials only, without tokens) for an operator view. */
  list(): Array<Omit<ProductCredential, 'token' | 'subject'>> {
    return [...this.byProduct.values()].map(({ token: _t, subject: _s, ...rest }) => rest);
  }

  /** List subject tokens for a product (metadata only, no token values). */
  listScoped(product: string): Array<Omit<ProductCredential, 'token'>> {
    const out: Array<Omit<ProductCredential, 'token'>> = [];
    for (const c of this.scoped.values()) {
      if (c.product === product) {
        const { token: _t, ...rest } = c;
        out.push(rest);
      }
    }
    return out;
  }

  private persist(): void {
    this.backing.save([...this.byProduct.values(), ...this.scoped.values()]);
  }
}
