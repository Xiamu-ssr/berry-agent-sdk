export { A8sClient, A8sRequestError } from './a8s-client.js';
export type { A8sClientOptions } from './a8s-client.js';
export { AgentHandle } from './agent-handle.js';
export type { AgentStreamEvent, SubscribeOptions } from './agent-handle.js';

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

// Hand recipes
export type {
  HandRecipe,
  HandRecipeListResponse,
  HandRecipeRegisterRequest,
} from '@berry-agent/cluster-protocol';

// Skill registry (operator catalog)
export type {
  OperatorSkillListResponse,
  OperatorSkillDetail,
  OperatorSkillRegisterRequest,
  OperatorSkillInstallResponse,
} from '@berry-agent/cluster-protocol';

// Credentials (product token management)
export type {
  ProductCredentialListResponse,
  ProductCredentialIssueRequest,
  ProductCredentialIssueResponse,
  ScopedTokenIssueRequest,
  ScopedTokenIssueResponse,
} from '@berry-agent/cluster-protocol';

// Audit
export type { AuditQueryResponse } from '@berry-agent/cluster-protocol';
