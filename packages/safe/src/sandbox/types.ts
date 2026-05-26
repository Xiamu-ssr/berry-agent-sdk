// ============================================================
// Berry Agent SDK — Sandbox Types
// ============================================================
//
// SandboxConfig extends the SDK execution isolation contract with
// platform-specific runner selection.

import type { ExecutionIsolationPolicy } from '@berry-agent/core';

/**
 * Sandbox configuration.
 *
 * All paths should be absolute. Relative paths are resolved
 * against the process cwd at sandbox creation time.
 */
export interface SandboxConfig extends ExecutionIsolationPolicy {
  /**
   * Platform override. If not set, auto-detected from process.platform.
   * Useful for testing or when running in unusual environments.
   */
  platform?: 'macos' | 'linux';
}

/**
 * Resolved sandbox profile (platform-specific).
 * Not meant to be constructed directly — use createSandbox().
 */
export interface SandboxProfile {
  /** The platform this profile targets. */
  platform: 'macos' | 'linux';

  /** The Seatbelt profile source (.sb) or bubblewrap arguments. */
  readonly profile: string;

  /** The config that generated this profile. */
  readonly config: SandboxConfig;
}
