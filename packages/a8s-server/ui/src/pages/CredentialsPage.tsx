import { PageHeader, EmptyState } from '../components/Page.js';

/**
 * Credentials — issue/revoke product-scoped tokens.
 *
 * The backing store (ProductCredentialStore) already exists in a8s, but the
 * operator HTTP routes are not wired yet (P3). This page is the placeholder
 * so the nav slot is real; it becomes the issue/revoke panel once
 * GET/POST/DELETE /v1/operator/product-credentials land.
 */
export function CredentialsPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Credentials"
        subtitle="Product-scoped tokens — each product sees only its own agents"
      />
      <EmptyState
        icon="🔑"
        title="Credential management is coming"
        hint="ProductCredentialStore is live in a8s; the issue/revoke routes are being wired. A product token (bp_…) scopes a product to its own resources."
      />
    </div>
  );
}
