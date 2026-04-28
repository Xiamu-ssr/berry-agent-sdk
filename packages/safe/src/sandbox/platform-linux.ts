// ============================================================
// Berry Agent SDK — Sandboxed Executor (Linux bubblewrap) — STUB
// ============================================================
//
// Linux sandbox support using bubblewrap (bwrap).
// This is a placeholder — implementation planned for Phase 3.
// On Linux, createSandbox() currently falls back to NodeExecutor
// (no sandbox) with a console warning.

import type { CommandExecutor } from '@berry-agent/core';
import type { SandboxConfig } from './types.js';

/**
 * Create a sandboxed CommandExecutor for Linux using bubblewrap.
 * NOT YET IMPLEMENTED — returns null to indicate fallback is needed.
 */
export function createBubblewrapExecutor(_config: SandboxConfig): CommandExecutor | null {
  // Linux sandbox via bubblewrap is not yet implemented.
  // Caller should fall back to NodeExecutor (no sandbox).
  console.warn(
    '[safe] Linux sandbox (bubblewrap) is not yet implemented. ' +
    'Commands will run without OS-level isolation.'
  );
  return null;
}