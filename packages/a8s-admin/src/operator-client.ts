// ============================================================
// @berry-agent/a8s-admin — A8sOperatorClient (compat re-export)
// ============================================================
// The operator client now lives in @berry-agent/client as the single
// canonical A8sClient — one source of truth for talking to a8s. This
// module keeps the historical name working for existing callers
// (cluster-admin Hand, worker-daemon, bootstrap, remote-teammate).
//
// `A8sClientOptions` accepts both `token` and the older `adminToken`, so
// every existing `new A8sOperatorClient({ a8sUrl, adminToken })` call
// keeps compiling unchanged.

export { A8sClient as A8sOperatorClient, A8sRequestError } from '@berry-agent/client';
export type { A8sClientOptions as A8sOperatorClientOptions } from '@berry-agent/client';
