// ============================================================
// Berry Agent SDK — Command Environment Boundary
// ============================================================
//
// Tool shells and MCP stdio servers must not inherit the whole host process
// environment by default. Long-lived provider/API credentials stay behind
// CredentialStore; command runners receive a small, explicit process env plus
// per-call overrides supplied by the host/tool.

const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const DEFAULT_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'CI',
] as const;

export type CommandEnvironment = Record<string, string>;

export interface CommandEnvironmentOptions {
  /**
   * Explicit additions/overrides. Use `undefined` to remove a default key.
   * Secrets should only appear here when the host intentionally proxies a
   * scoped, task-specific credential into the runner.
   */
  env?: Record<string, string | undefined>;
  /** Additional host env keys to copy from process.env. */
  inheritKeys?: readonly string[];
}

export function createCommandEnvironment(options: CommandEnvironmentOptions = {}): CommandEnvironment {
  const env: CommandEnvironment = {};
  const keys = new Set<string>([...DEFAULT_ENV_KEYS, ...(options.inheritKeys ?? [])]);

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }

  if (!env.PATH) env.PATH = DEFAULT_PATH;

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return env;
}
