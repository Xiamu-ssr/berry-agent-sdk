// ============================================================
// @berry-agent/worker-daemon — Admin-ops credential-injecting env
// ============================================================
//
// The `berry-admin` agent operates the cluster by running the
// `berry-a8s-ops` CLI through its ordinary shell Hand (see 新-2 in
// docs/env-hand-skill-cli-memo.md: cluster ops are *knowledge* — a CLI +
// skill — not hardcoded execution-layer tools). That CLI needs the a8s
// URL + admin token, which it reads from BERRY_A8S_URL /
// BERRY_A8S_ADMIN_TOKEN in its process env.
//
// But the SDK's command environment is intentionally allow-listed
// (packages/core command-environment.ts): BERRY_* never reaches a shell
// child by default. So we inject those two vars *only* into the execution
// environment of agents labelled role=a8s-admin, by wrapping the env's
// CommandExecutor so every exec/spawn merges the extra vars into
// `options.env` (which both NodeExecutor and the Seatbelt executor pass to
// createCommandEnvironment, where per-call env overrides the allow-list).
//
// Security boundary (lanxuan signed off, 2026-06-02): the admin agent
// controls a shell, so it *can* echo the token — an accepted regression
// vs. the old in-process tools, scoped to the admin label only. No other
// agent's executor is wrapped.

import { exec as nodeExec, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  composeExecResult,
  createCommandEnvironment,
  createExecutionEnvironment,
  isolationPolicyFromScope,
  processHandleFromChild,
  type AgentScope,
  type CommandExecutor,
  type ExecOptions,
  type ExecutionEnvironment,
  type ExecutionEnvironmentProvider,
  type ProcessHandle,
  type SpawnOptions,
} from '@berry-agent/core';

/** Extra environment variables to expose to the admin agent's commands. */
export type AdminOpsEnv = Record<string, string>;

/**
 * Wrap a CommandExecutor so every exec/spawn call carries `extraEnv`,
 * unless the caller already set the same key (caller intent wins).
 */
function wrapExecutor(base: CommandExecutor, extraEnv: AdminOpsEnv): CommandExecutor {
  const mergeEnv = (callerEnv: Record<string, string | undefined> | undefined) => ({
    ...extraEnv,
    ...(callerEnv ?? {}),
  });
  return {
    exec(command, options) {
      return base.exec(command, { ...options, env: mergeEnv(options.env) });
    },
    spawn(command, options) {
      return base.spawn(command, { ...options, env: mergeEnv(options.env) });
    },
  };
}

/**
 * A bare (unsandboxed) executor used only when the base environment has no
 * executor of its own — e.g. on a Linux host where the OS sandbox isn't
 * available and the default provider's createCommandExecutor returns null.
 * Mirrors tools-common's NodeExecutor but inlined to avoid a dependency
 * (worker-daemon must not pull tools-common). The extra env is injected
 * the same way: through options.env → createCommandEnvironment.
 */
function bareInjectingExecutor(extraEnv: AdminOpsEnv): CommandExecutor {
  const mergeEnv = (callerEnv: Record<string, string | undefined> | undefined) =>
    createCommandEnvironment({ env: { ...extraEnv, ...(callerEnv ?? {}) } });
  return {
    exec(command: string, options: ExecOptions) {
      return new Promise((resolve) => {
        nodeExec(
          command,
          {
            cwd: options.cwd,
            timeout: options.timeout,
            maxBuffer: options.maxBuffer ?? 1024 * 1024,
            env: mergeEnv(options.env),
          },
          (error, stdout, stderr) => {
            resolve(composeExecResult(stdout ?? '', stderr ?? '', error, error ? true : false));
          },
        );
      });
    },
    spawn(command: string, options: SpawnOptions): ProcessHandle {
      const child = nodeSpawn(command, {
        cwd: options.cwd,
        shell: true,
        stdio: 'pipe',
        env: mergeEnv(options.env),
      }) as ChildProcessWithoutNullStreams;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      return processHandleFromChild(child);
    },
  };
}

/**
 * Build an ExecutionEnvironmentProvider that injects `extraEnv` into the
 * commands of whatever environment `base` would have provisioned. If
 * `base` is undefined (spec had no provider), the worker's default sandbox
 * provider should be passed in by the caller; if even that yields no
 * executor, we fall back to a bare injecting executor so the CLI still
 * gets its credentials.
 *
 * The returned environment keeps the base env's identity/isolation but
 * swaps in a wrapped executor. Other surfaces (createHands, dispose) are
 * delegated to the base when present.
 *
 * Provisioning stays synchronous when the base is synchronous — the worker
 * mounts agents through the sync runtime builder (createManagedRuntime),
 * which rejects a Promise-returning provider. We only return a Promise if
 * the base provider itself does.
 */
export function createCredentialInjectingProvider(
  base: ExecutionEnvironmentProvider | undefined,
  extraEnv: AdminOpsEnv,
): ExecutionEnvironmentProvider {
  return {
    provision(request) {
      const baseEnv = base?.provision(request);
      if (baseEnv && typeof (baseEnv as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(baseEnv as Promise<ExecutionEnvironment | undefined>)
          .then((resolved) => wrapEnvironment(resolved, extraEnv));
      }
      return wrapEnvironment(baseEnv as ExecutionEnvironment | undefined, extraEnv);
    },
  };
}

function wrapEnvironment(
  baseEnv: ExecutionEnvironment | undefined,
  extraEnv: AdminOpsEnv,
): ExecutionEnvironment {
  return createExecutionEnvironment({
    id: baseEnv?.id ?? 'admin-ops',
    kind: baseEnv?.kind ?? 'os-sandbox',
    displayName: baseEnv?.displayName ?? 'a8s admin ops',
    createCommandExecutor: (scope: AgentScope) => {
      const baseExecutor = baseEnv?.createCommandExecutor?.(scope) ?? null;
      return baseExecutor
        ? wrapExecutor(baseExecutor, extraEnv)
        : bareInjectingExecutor(extraEnv);
    },
    createHands: baseEnv?.createHands ? (scope) => baseEnv.createHands!(scope) : undefined,
    isolationPolicy: baseEnv?.isolationPolicy
      ? (scope) => baseEnv.isolationPolicy!(scope)
      : (scope) => isolationPolicyFromScope(scope),
    dispose: baseEnv?.dispose ? () => baseEnv.dispose!() : undefined,
  });
}
