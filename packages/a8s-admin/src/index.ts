// ============================================================
// @berry-agent/a8s-admin — Public API
// ============================================================
//
// Two surfaces:
//
//   - `A8sOperatorClient` — typed HTTP client over /v1/operator/*.
//     Use directly from CLI tools, monitoring scrapers, scripts.
//
//   - `createClusterAdminHand(client)` — wraps the client as a Hand so
//     a berry agent (typically the auto-spawned `berry-admin` agent in
//     the local worker) can operate the cluster through tool calls.

export { A8sOperatorClient } from './operator-client.js';
export type { A8sOperatorClientOptions } from './operator-client.js';
export { createClusterAdminHand } from './cluster-admin-hand.js';
export type { ClusterAdminHandOptions } from './cluster-admin-hand.js';
