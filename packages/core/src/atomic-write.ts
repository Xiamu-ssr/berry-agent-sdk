// ============================================================
// Berry Agent SDK — Atomic JSON Write
// ============================================================
//
// Write-to-temp-then-rename pattern in one place. Several stores
// (credentials, sessions, orchestration, team, worklist) all need
// to persist JSON without leaving a half-written file behind if the
// process dies mid-save. Rename is atomic on POSIX, which gives us
// crash-safety for free as long as everyone goes through the same
// helper.

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WriteJsonAtomicOptions {
  /** Create parent directories before writing. Default: true. */
  mkdir?: boolean;
  /** File mode for the initial write (e.g. 0o600 for secrets). */
  mode?: number;
  /**
   * Re-apply mode after rename (best-effort). Some platforms (Windows,
   * certain volume mounts) silently ignore the initial mode; chmod
   * after rename is a defensive second attempt and is not fatal on
   * failure.
   */
  chmodAfter?: boolean;
  /** Append a trailing newline to the JSON output. Default: false. */
  trailingNewline?: boolean;
  /** JSON.stringify indentation. Default: 2. */
  indent?: number;
}

/**
 * Atomically write a JSON value to `path`. Writes to `${path}.tmp`
 * first, then renames over the destination — POSIX guarantees the
 * rename is atomic, so a crash mid-save leaves either the old file
 * intact or the new file fully written, never a torn write.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  const {
    mkdir: shouldMkdir = true,
    mode,
    chmodAfter = false,
    trailingNewline = false,
    indent = 2,
  } = options;

  if (shouldMkdir) {
    await mkdir(dirname(path), { recursive: true });
  }

  const tmp = `${path}.tmp`;
  const body = JSON.stringify(value, null, indent) + (trailingNewline ? '\n' : '');
  await writeFile(tmp, body, { encoding: 'utf-8', ...(mode !== undefined ? { mode } : {}) });
  await rename(tmp, path);

  if (chmodAfter && mode !== undefined) {
    try {
      await chmod(path, mode);
    } catch {
      // best-effort — some filesystems/platforms ignore chmod
    }
  }
}
