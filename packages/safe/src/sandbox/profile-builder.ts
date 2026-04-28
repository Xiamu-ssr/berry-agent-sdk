// ============================================================
// Berry Agent SDK — Seatbelt Profile Builder (macOS)
// ============================================================
//
// Generates a Seatbelt .sb profile string from a SandboxConfig.
//
// Key design decisions for macOS:
// - file-read* is allowed GLOBALLY by default. macOS bash and
//   most commands need access to many system paths (dyld cache,
//   locale, terminfo, /dev/null, shared libraries, etc.) that
//   are impossible to enumerate reliably. Restricting read causes
//   SIGABRT. Read-level isolation is handled by the ToolGuard
//   (directoryScope) at the application layer instead.
// - file-write* is strictly limited to specified directories.
// - Network is denied by default (the primary egress concern).
// - Process execution is allowed (shell needs this).
// - All paths are resolved to real paths via realpathSync() because
//   macOS uses symlinks extensively (/tmp → /private/tmp, etc.)
//   and Seatbelt only matches against real paths.

import { realpathSync } from 'node:fs';
import type { SandboxConfig } from './types.js';

/**
 * Build a Seatbelt .sb profile string from a SandboxConfig.
 */
export function buildSeatbeltProfile(config: SandboxConfig): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
  ];

  // --- Filesystem: read ---
  // On macOS, we allow global file-read because bash and most commands
  // need access to many system paths (dyld, locale, terminfo, etc.)
  // that are impossible to enumerate. Fine-grained read restrictions
  // are handled by ToolGuard (directoryScope) at the application layer.
  if (config.allowRead.length > 0) {
    lines.push('(allow file-read*)');
  }

  // --- Filesystem: write ---
  if (config.allowWrite.length > 0) {
    for (const dir of config.allowWrite) {
      const resolved = resolvePath(dir);
      lines.push(`(allow file-write* (subpath "${escapeSb(resolved)}"))`);
      // Also add the original path in case it's a symlink that Seatbelt
      // resolves differently (belt-and-suspenders approach)
      if (resolved !== dir) {
        lines.push(`(allow file-write* (subpath "${escapeSb(dir)}"))`);
      }
    }
  }

  // --- Explicit deny paths (override allow rules) ---
  if (config.denyPaths && config.denyPaths.length > 0) {
    for (const p of config.denyPaths) {
      const resolved = resolvePath(p);
      lines.push(`(deny file-read* (subpath "${escapeSb(p)}"))`);
      lines.push(`(deny file-write* (subpath "${escapeSb(p)}"))`);
      // Also deny the resolved path if different
      if (resolved !== p) {
        lines.push(`(deny file-read* (subpath "${escapeSb(resolved)}"))`);
        lines.push(`(deny file-write* (subpath "${escapeSb(resolved)}"))`);
      }
    }
  }

  // --- Process execution ---
  if (config.allowExec !== false) {
    lines.push('(allow process-exec)');
    lines.push('(allow process-fork)');
    lines.push('(allow signal)');
  }

  // --- Network ---
  switch (config.network) {
    case 'allow':
      lines.push('(allow network*)');
      break;
    case 'deny':
      lines.push('(deny network*)');
      break;
    default:
      // { allowDomains: [...] } — deny all, then allow specific
      lines.push('(deny network*)');
      if (config.network.allowDomains.length > 0) {
        for (const domain of config.network.allowDomains) {
          lines.push(`(allow network-outbound (literal "${escapeSb(domain)}"))`);
        }
      }
      break;
  }

  // --- System basics needed for process execution on macOS ---
  lines.push('(allow mach-lookup)');        // IPC, DNS resolution, launchd
  lines.push('(allow file-read-metadata)'); // stat(), access(), lstat()
  lines.push('(allow sysctl-read)');         // System info queries (uname, etc.)
  lines.push('(allow ipc-posix-sem)');       // POSIX semaphores
  lines.push('(allow ipc-posix-shm)');       // POSIX shared memory
  lines.push('(allow file-write-data (literal "/dev/null"))'); // /dev/null for redirection

  return lines.join('\n') + '\n';
}

/**
 * Resolve a path to its real (non-symlink) form.
 * Falls back to the original path if resolution fails (e.g., path doesn't exist yet).
 */
function resolvePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Escape a path for Seatbelt profile string.
 * Seatbelt profiles use "..." literal strings; we only need to escape " and \.
 */
function escapeSb(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}