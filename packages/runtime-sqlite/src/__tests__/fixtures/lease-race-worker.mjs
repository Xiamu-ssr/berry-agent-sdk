// ============================================================
// Test fixture — runs in a node worker_thread
// ============================================================
// Plain .mjs so node can load it directly (no TS loader inside the
// thread). Imports resolve through node_modules to the workspace-linked
// dist of @berry-agent/runtime + the local dist of
// @berry-agent/runtime-sqlite.

import { workerData, parentPort } from 'node:worker_threads';
import { RuntimeOrchestrator } from '@berry-agent/runtime';
import { SqliteRuntimeOrchestrationStore } from '../../../dist/store.js';

async function run() {
  const { dbPath, mode, workerId, agentId, ttlMs, capacity } = workerData;
  const store = new SqliteRuntimeOrchestrationStore({ dbPath, busyTimeoutMs: 15_000 });
  const orchestrator = new RuntimeOrchestrator({ store });

  try {
    if (mode === 'single-lease') {
      const result = await orchestrator.acquireLease({
        agentId,
        holderId: workerId,
        ttlMs,
      });
      parentPort?.postMessage({
        workerId,
        acquired: result.acquired,
        reason: result.acquired ? undefined : `held-by:${result.active.holderId}`,
      });
      return;
    }

    if (mode === 'register-worker') {
      await orchestrator.registerWorker({
        holderId: workerId,
        capacity,
        heartbeatTtlMs: 120_000,
        workerId,
      });
      parentPort?.postMessage({ workerId, acquired: true });
      return;
    }

    if (mode === 'distinct-lease') {
      try {
        const result = await orchestrator.acquireLease({
          agentId,
          holderId: workerId,
          workerId,
          ttlMs,
        });
        parentPort?.postMessage({
          workerId,
          acquired: result.acquired,
          reason: result.acquired ? undefined : 'lease-conflict',
        });
      } catch (error) {
        parentPort?.postMessage({
          workerId,
          acquired: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    throw new Error(`Unknown mode: ${mode}`);
  } finally {
    store.close();
  }
}

run().catch((error) => {
  parentPort?.postMessage({
    workerId: workerData?.workerId ?? '?',
    acquired: false,
    reason: error instanceof Error ? error.message : String(error),
  });
});
