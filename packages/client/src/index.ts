// ============================================================
// @berry-agent/client — Public API
// ============================================================
// The standard way any Berry product talks to an a8s control plane.
// a8s is the (remote) backend; products are thin front ends that drive
// agents through this client. One client, reused across every product —
// no per-product re-implementation of the a8s wire calls.

export { A8sClient, A8sRequestError } from './a8s-client.js';
export type { A8sClientOptions } from './a8s-client.js';
export { AgentHandle } from './agent-handle.js';
export type { AgentStreamEvent, SubscribeOptions } from './agent-handle.js';

// Usage / observability response types — products binding an Audit/Usage view
// import these straight from the client (the canonical cluster-protocol shapes).
export type {
  OperatorUsageResponse,
  OperatorUsageAgentRow,
  AgentUsageResponse,
  AgentUsage,
  UsageSession,
  UsageSessionListResponse,
  UsageTurn,
  UsageTurnListResponse,
  UsageInference,
  UsageInferenceListResponse,
  UsageInferenceDetail,
  UsageInferenceDetailResponse,
} from '@berry-agent/cluster-protocol';

// Team (emergent) — project-scoped worklist + message types.
export type {
  WorklistTask,
  WorklistTaskStatus,
  WorklistResponse,
  WorklistCreateRequest,
  WorklistPatchRequest,
  TeamMessage,
  TeamMessagesResponse,
  TeamMessageAppendRequest,
  AgentLocation,
  ListAgentsResponse,
} from '@berry-agent/cluster-protocol';
