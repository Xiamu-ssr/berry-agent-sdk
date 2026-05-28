// ============================================================
// @berry-agent/worker — Test utilities
// ============================================================
// Shared test helpers used by the worker package itself and by downstream
// packages (a8s) whose tests need a minimal-but-valid WorkerAgentSpec +
// WorkerEnvironment to drive a real ManagedAgentRuntime through
// buildAgentRuntime / Worker / ControlPlane.
//
// These are intentionally exported (and ship in the published dist) so
// any downstream package can compose them without copy-pasting the same
// 16-line `as ModelsRegistry` literal four times across the SDK.
//
// They are **not** suitable for production: the registry is a static
// fake with a synthetic API key, the credentials store points at a tmp
// path, and the observer uses an in-memory SQLite DB.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHome, DefaultCredentialStore } from '@berry-agent/core';
import type { ModelsRegistry } from '@berry-agent/models';
import { createObserver } from '@berry-agent/observe';
import type { WorkerAgentSpec, WorkerEnvironment } from './types.js';

/**
 * A minimal `ModelsRegistry` that resolves `tier:strong` → an Anthropic
 * provider with a synthetic API key. Suitable for tests that need a
 * runtime to *build* without ever calling a real LLM.
 */
export function buildTestRegistry(): ModelsRegistry {
  return {
    providers: {
      'test-provider': {
        id: 'test-provider',
        presetId: 'anthropic',
        apiKey: 'sk-test',
      },
    },
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        contextWindow: 200_000,
        providers: [{ providerId: 'test-provider' }],
      },
    },
    tiers: { strong: 'claude-sonnet-4-5' },
  } as ModelsRegistry;
}

/**
 * Build a complete `WorkerEnvironment` against a freshly minted tmp dir.
 * Caller owns the returned `root` path — for tests, just let the OS
 * clean it up.
 */
export function makeTestWorkerEnv(root: string): WorkerEnvironment {
  return {
    registry: buildTestRegistry(),
    credentials: new DefaultCredentialStore({ filePath: join(root, 'creds.json') }),
    observer: createObserver({ dbPath: ':memory:' }),
  };
}

/**
 * Build a minimal `WorkerAgentSpec` rooted under `root/<agentId>`.
 * Skips the default MCP config seeding so tests don't touch the real
 * Playwright MCP template.
 */
export function makeTestAgentSpec(agentId: string, root: string): WorkerAgentSpec {
  const workspace = join(root, agentId);
  return {
    agentId,
    workspace,
    home: new AgentHome(workspace),
    model: 'tier:strong',
    ensureDefaultMcpConfig: false,
  };
}

/**
 * One-shot helper: mkdtemp + env + spec for the common single-agent test
 * case. Returns the temp root so the caller can stash it for later
 * inspection / cleanup.
 */
export function makeTestWorkerSetup(prefix = 'worker-test-'): {
  root: string;
  env: WorkerEnvironment;
  spec: (agentId: string) => WorkerAgentSpec;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    env: makeTestWorkerEnv(root),
    spec: (agentId: string) => makeTestAgentSpec(agentId, root),
  };
}
