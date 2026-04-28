// ============================================================
// Berry Agent SDK — Default Sandbox Configuration
// ============================================================
//
// Sensible defaults for a development-agent sandbox.
//
// Security model:
//   Read:   Globally allowed (macOS compatibility requires it).
//           Application-layer ToolGuard (directoryScope) handles
//           fine-grained read restrictions.
//   Write:  Restricted to project root + /tmp.
//   Network: Allowed by default (agents need npm install, git, API calls).
//           Filesystem isolation prevents the primary exfil risk:
//           credentials are blocked by denyPaths, so they can't be
//           read in the first place; without the data, network access
//           alone can't leak them.
//   Exec:   Allowed (shell needs this).
//   Deny:   Sensitive credential paths explicitly blocked.

import type { SandboxConfig } from './types.js';

/**
 * Build a default SandboxConfig for a given project root.
 *
 * This is the recommended starting point. Override specific fields
 * as needed (e.g. allow network for specific tools).
 *
 * @param projectRoot — The directory the agent works in (read + write).
 * @param overrides — Partial overrides merged on top of defaults.
 */
export function defaultSandboxConfig(
  projectRoot: string,
  overrides?: Partial<SandboxConfig>,
): SandboxConfig {
  const home = process.env.HOME || '/root';

  const defaults: SandboxConfig = {
    // Read: globally allowed on macOS (bash needs many system paths).
    // Fine-grained read isolation is handled by ToolGuard directoryScope.
    allowRead: ['/'],

    // Write: only project root and temp directory.
    allowWrite: [
      projectRoot,
      '/tmp',
    ],

    // Explicitly deny access to sensitive credential/key paths.
    // These override the global read-allow rule.
    denyPaths: [
      '/etc/shadow',               // System password hashes
      '/etc/sudoers',              // Sudo configuration
      `${home}/.ssh`,              // SSH private keys
      `${home}/.gnupg`,            // GPG keys
      `${home}/.aws`,              // AWS credentials
      `${home}/.config/gcloud`,    // GCP credentials
      `${home}/.kube`,             // Kubernetes credentials
    ],

    // Network: allowed by default. Agents need network for
    // npm install, git push, API calls, etc.
    // Filesystem isolation prevents the primary exfil risk
    // (credentials blocked by denyPaths above — can't read them,
    // can't send them). Override to 'deny' if needed.
    network: 'allow',

    // Exec: required for shell commands.
    allowExec: true,
  };

  return { ...defaults, ...overrides };
}