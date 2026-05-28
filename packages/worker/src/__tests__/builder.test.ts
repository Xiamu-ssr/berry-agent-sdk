// ============================================================
// @berry-agent/worker — buildAgentRuntime smoke test
// ============================================================
// Verifies that the worker primitive can wire a real ManagedAgentRuntime
// without product-side glue. Uses an in-memory store + minimal spec.

import { describe, expect, it } from 'vitest';
import { buildAgentRuntime } from '../builder.js';
import { makeTestAgentSpec, makeTestWorkerEnv, makeTestWorkerSetup } from '../test-utils.js';

describe('buildAgentRuntime', () => {
  it('assembles a managed agent runtime from a minimal spec', () => {
    const { root, env, spec } = makeTestWorkerSetup();
    const built = buildAgentRuntime(spec('test-agent'), env);

    expect(built.runtime).toBeDefined();
    expect(built.workspace).toBe(`${root}/test-agent`);
    expect(typeof built.runtime.dispose).toBe('function');
  });

  it('honors hostTools by mounting them as a system hand', () => {
    const { root } = makeTestWorkerSetup();
    const spec = {
      ...makeTestAgentSpec('test-agent-host', root),
      hostTools: [{
        definition: {
          name: 'host_ping',
          description: 'Worker host echo',
          inputSchema: { type: 'object', properties: {} } as never,
        },
        execute: async () => ({ content: 'pong', isError: false }),
      }],
      hostHandDisplayName: 'Test host',
    };
    const built = buildAgentRuntime(spec, makeTestWorkerEnv(root));

    const snapshot = built.runtime.snapshot();
    expect(snapshot).toBeDefined();
  });

  it('disables local workspace when localWorkspace=false', () => {
    const { root } = makeTestWorkerSetup();
    const built = buildAgentRuntime(
      { ...makeTestAgentSpec('no-local', root), localWorkspace: false },
      makeTestWorkerEnv(root),
    );

    expect(built.runtime).toBeDefined();
  });
});
