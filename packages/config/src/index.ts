// ============================================================
// @berry-agent/config — public surface
// ============================================================
//
// One file, one job: the SDK-level config loader. Hosts call
// `loadSdkConfig(path)` at startup, hand the returned object to the
// Agent, and are done.

export { loadSdkConfig, SdkConfigError } from './loader.js';
export type {
  BerrySdkConfig,
  SafeNamespaceConfig,
  ToolsCommonNamespaceConfig,
  ObserveNamespaceConfig,
} from './types.js';
