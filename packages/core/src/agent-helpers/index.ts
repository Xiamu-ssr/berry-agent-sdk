// ============================================================
// Agent helpers — barrel export
// ============================================================
// Pure helpers split out of agent.ts. Import from here rather
// than from the individual files; the file split is an internal
// organization detail and may change.

export { generateId, generateEventId, generateTurnId } from './ids.js';
export { bootAgent } from './boot.js';
export type { AgentBootState } from './boot.js';
export {
  sleep,
  createProvider,
  isProviderResolver,
  providerConfigsEqual,
  isPromptTooLongError,
  extractContextWindowFromError,
} from './provider.js';
export {
  resolveInitialProviderRuntime,
  resolveModelRefRuntime,
  resolveProviderInput,
} from './provider-runtime.js';
export type { ProviderRuntimeResolution } from './provider-runtime.js';
export { AgentProviderController } from './provider-controller.js';
export type { AgentProviderControllerOptions } from './provider-controller.js';
export {
  createInMemoryStore,
  createEmptySessionMetadata,
} from './session.js';
export {
  extractText,
  accumulateUsage,
  mergeToolsByName,
  repairOrphanToolUses,
} from './messages.js';
export {
  snapshotFrom,
  getToolsFrom,
  getSkillMetasFrom,
  getMCPFrom,
} from './introspection.js';
export type { IntrospectionDeps, AgentSnapshot, MCPSummary } from './introspection.js';
export { SkillManager } from './skill-manager.js';
export type { SkillManagerOptions } from './skill-manager.js';
export { runDelegate } from './delegate.js';
export type { DelegateDeps } from './delegate.js';
export { SessionController } from './session-controller.js';
export type { SessionControllerDeps } from './session-controller.js';
export { compactSessionMessages } from './session-compaction.js';
export type { SessionCompactionDeps } from './session-compaction.js';
export { callProvider } from './provider-call.js';
export type { ProviderCallDeps } from './provider-call.js';
export {
  applyBeforeApiCall,
  notifyAfterApiCall,
  notifyApiCallError,
} from './middleware.js';
export { destroyAgentRuntime } from './lifecycle.js';
export type { AgentLifecycleDestroyDeps } from './lifecycle.js';
export { AgentWorkspaceData } from './workspace-data.js';
export type { AgentWorkspaceDataDeps } from './workspace-data.js';
export { buildAgentSystemPrompt, resolveAgentTools } from './runtime-context.js';
export type { AgentSystemPromptDeps, AgentToolResolverDeps } from './runtime-context.js';
export { AgentRunState } from './run-state.js';
export type { ActiveAgentTurn } from './run-state.js';
export { AgentCompactionCoordinator } from './compaction-coordinator.js';
export type { AgentCompactionCoordinatorDeps, AgentCompactionRequest } from './compaction-coordinator.js';
export { registerBuiltinAgentTools } from './builtin-tools.js';
export type { BuiltinAgentToolDeps } from './builtin-tools.js';
export {
  CONFIGURED_TOOLS_HAND_ID,
  MEMORY_PROVIDER_HAND_ID_PREFIX,
  RUNTIME_TOOL_HAND_ID_PREFIX,
  registerConfiguredToolCapabilities,
  registerHandCapabilities,
  registerMemoryProviderCapabilities,
  registerRuntimeToolCapability,
  unregisterHandCapabilities,
  unregisterToolCapability,
} from './capabilities.js';
export type { AgentCapabilityRegistry } from './capabilities.js';
export { runAgentQueryLoop } from './query-loop.js';
export type { AgentQueryLoopDeps, AgentQueryLoopParams } from './query-loop.js';
export { runAgentTurn } from './turn.js';
export type { AgentTurnDeps } from './turn.js';
