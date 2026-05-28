// ============================================================
// SQLite multi-process concurrency test
// ============================================================
// Spins up N worker_threads, each opens the same on-disk SQLite database
// and races to acquire the same lease. Only one process should win; all
// others should observe `acquired: false`. Then they race to acquire N
// distinct agent leases with capped worker capacity — total successes
// must equal the capacity, never more.
//
// This is the test the M2 v0 implementation lacked. With BEGIN IMMEDIATE
// wrapping every transact(), it should pass deterministically.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'fixtures', 'lease-race-worker.mjs');

interface LeaseWorkerResult {
  workerId: string;
  acquired: boolean;
  reason?: string;
}

function runWorker(payload: Record<string, unknown>): Promise<LeaseWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorker(WORKER_SCRIPT, { workerData: payload });
    worker.once('message', (msg) => resolve(msg as LeaseWorkerResult));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

describe('SqliteRuntimeOrchestrationStore — true cross-thread races', () => {
  it('exactly one worker wins when N threads race for the same lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sqlite-race-'));
    const dbPath = join(root, 'orch.db');
    const concurrency = 8;

    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => runWorker({
        dbPath,
        mode: 'single-lease',
        workerId: `t${i}`,
        agentId: 'shared',
        ttlMs: 60_000,
      })),
    );

    const winners = results.filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.acquired)).toHaveLength(concurrency - 1);
  });

  it('capacity is enforced strictly under concurrent worker leases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sqlite-race-'));
    const dbPath = join(root, 'orch.db');
    const concurrency = 10;
    const capacity = 3;

    // Pre-register a single worker entry with capacity 3.
    const setup = await runWorker({
      dbPath,
      mode: 'register-worker',
      workerId: 'cluster-worker-1',
      capacity,
    });
    expect(setup.acquired).toBe(true);

    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => runWorker({
        dbPath,
        mode: 'distinct-lease',
        workerId: 'cluster-worker-1',
        agentId: `agent-${i}`,
        ttlMs: 60_000,
      })),
    );

    const won = results.filter((r) => r.acquired);
    const lost = results.filter((r) => !r.acquired);
    expect(won.length).toBe(capacity);
    expect(lost.length).toBe(concurrency - capacity);
    // Capacity errors must surface as the explicit message, not a serialization fluke
    for (const failed of lost) {
      expect(failed.reason).toMatch(/at capacity/);
    }
  });
});
