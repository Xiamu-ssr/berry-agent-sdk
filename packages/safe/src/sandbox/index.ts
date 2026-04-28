// ============================================================
// @berry-agent/safe — Sandbox Module
// ============================================================
//
// OS-level command isolation for Berry Agent.
//
// macOS:  Seatbelt (sandbox-exec) — zero dependencies, system built-in
// Linux:  bubblewrap (bwrap) — not yet implemented (Phase 3)
//
// Usage:
//   import { createSandbox } from '@berry-agent/safe';
//   const executor = createSandbox({
//     allowRead: [projectRoot, '/usr', '/tmp'],
//     allowWrite: [projectRoot],
//     network: 'deny',
//   });
//   const tools = createShellTools(projectRoot, { executor });

import type { CommandExecutor } from '@berry-agent/core';
import type { SandboxConfig, SandboxProfile } from './types.js';
import { buildSeatbeltProfile } from './profile-builder.js';
import { createSandboxedExecutor } from './platform-macos.js';

export type { SandboxConfig, SandboxProfile } from './types.js';
export { buildSeatbeltProfile } from './profile-builder.js';
export { defaultSandboxConfig } from './default-config.js';
export { createSandboxedExecutor } from './platform-macos.js';

/**
 * Create a sandboxed CommandExecutor based on the current platform.
 *
 * macOS → Seatbelt (sandbox-exec)
 * Linux → bubblewrap (not yet implemented, falls back to NodeExecutor)
 *
 * @param config — Sandbox configuration
 * @returns A CommandExecutor that runs commands in an OS-level sandbox,
 *          or null if the platform is not supported.
 */
export function createSandbox(config: SandboxConfig): CommandExecutor | null {
  const platform = config.platform ?? detectPlatform();

  switch (platform) {
    case 'macos':
      return createSandboxedExecutor(config);
    case 'linux':
      // Lazy-import to avoid breaking on platforms without bubblewrap
      try {
        const { createBubblewrapExecutor } = require('./platform-linux.js') as {
          createBubblewrapExecutor: (cfg: SandboxConfig) => CommandExecutor | null;
        };
        return createBubblewrapExecutor(config);
      } catch {
        console.warn('[safe] Linux sandbox unavailable. Commands will run unsandboxed.');
        return null;
      }
    default:
      console.warn(`[safe] Sandbox not supported on platform: ${platform}. Commands will run unsandboxed.`);
      return null;
  }
}

/**
 * Build a sandbox profile without creating an executor.
 * Useful for debugging / inspecting the generated Seatbelt policy.
 */
export function buildSandboxProfile(config: SandboxConfig): SandboxProfile {
  const platform = config.platform ?? detectPlatform();
  const profile = buildSeatbeltProfile(config);
  return { platform, profile, config };
}

function detectPlatform(): 'macos' | 'linux' {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'linux'; // fallback
  }
}