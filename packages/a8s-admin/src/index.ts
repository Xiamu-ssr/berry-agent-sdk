// ============================================================
// @berry-agent/a8s-admin — Public API
// ============================================================
//
// Three surfaces:
//
//   - `A8sOperatorClient` — typed HTTP client over /v1/operator/* +
//     admin-scope agent endpoints. Use directly from CLI tools,
//     monitoring scrapers, scripts.
//
//   - `createClusterAdminHand(client)` — wraps the client as a Hand so
//     a berry agent (typically the auto-spawned `berry-admin` agent in
//     the local worker) can operate the cluster through tool calls.
//
//   - `createRemoteTeammateRuntimeFactory(client)` — bridges
//     @berry-agent/team so a Team leader can spawn teammates as
//     first-class cluster agents living on (possibly different) workers
//     instead of in-process runtimes on the leader's worker.

export { A8sOperatorClient } from './operator-client.js';
export type { A8sOperatorClientOptions } from './operator-client.js';
export { createClusterAdminHand } from './cluster-admin-hand.js';
export type { ClusterAdminHandOptions } from './cluster-admin-hand.js';
export { createRemoteTeammateRuntimeFactory } from './remote-teammate.js';
export type { RemoteTeammateRuntimeFactoryOptions } from './remote-teammate.js';
