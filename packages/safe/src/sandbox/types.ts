// ============================================================
// Berry Agent SDK — Sandbox Types
// ============================================================
//
// SandboxConfig controls what the sandboxed process can access.
// This is OS-level isolation — the process gets "permission denied"
// for anything not explicitly allowed, without knowing it's sandboxed.

/**
 * Sandbox configuration.
 *
 * All paths should be absolute. Relative paths are resolved
 * against the process cwd at sandbox creation time.
 */
export interface SandboxConfig {
  /** Directories the process can read from. */
  allowRead: string[];

  /** Directories the process can write to. */
  allowWrite: string[];

  /** Paths the process is explicitly denied (overrides allow rules). */
  denyPaths?: string[];

  /**
   * Network access policy.
   * - 'allow'  → full network access
   * - 'deny'   → no network at all
   * - 'allowDomains' → only allow connections to listed domains
   */
  network: 'allow' | 'deny' | { allowDomains: string[] };

  /**
   * Whether to allow executing arbitrary commands.
   * Default: true (shell needs this).
   * Set to false for restricted exec-only sandboxes.
   */
  allowExec?: boolean;

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