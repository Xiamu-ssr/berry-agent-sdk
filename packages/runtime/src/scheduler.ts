// ============================================================
// @berry-agent/runtime — Wake Scheduler
// ============================================================
// A tiny default loop for host processes that want SDK-owned wake handling
// without inventing a product-side job table.

import { errorMessage } from '@berry-agent/core';
import {
  RuntimeOrchestrator,
  type RuntimeWake,
} from './orchestration.js';
import { unrefTimer } from './timer.js';

export interface ManagedRuntimeWakeSchedulerOptions {
  orchestrator: RuntimeOrchestrator;
  onWake: (wake: RuntimeWake) => Promise<void> | void;
  intervalMs?: number;
  claimLimit?: number;
  staleClaimedMs?: number;
  onError?: (error: unknown, wake?: RuntimeWake) => void;
}

export class ManagedRuntimeWakeScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly options: ManagedRuntimeWakeSchedulerOptions) {
    if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0)) {
      throw new Error('intervalMs must be a positive number');
    }
    if (options.claimLimit !== undefined && (!Number.isFinite(options.claimLimit) || options.claimLimit <= 0)) {
      throw new Error('claimLimit must be a positive number');
    }
    if (options.staleClaimedMs !== undefined && (!Number.isFinite(options.staleClaimedMs) || options.staleClaimedMs <= 0)) {
      throw new Error('staleClaimedMs must be a positive number');
    }
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.onError?.(error);
      });
    }, interval);
    unrefTimer(this.timer);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<RuntimeWake[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const wakes = await this.options.orchestrator.claimDueWakes({
        limit: this.options.claimLimit,
        staleClaimedMs: this.options.staleClaimedMs,
      });
      const handled: RuntimeWake[] = [];
      for (const wake of wakes) {
        handled.push(await this.handleWake(wake));
      }
      return handled;
    } finally {
      this.ticking = false;
    }
  }

  private async handleWake(wake: RuntimeWake): Promise<RuntimeWake> {
    try {
      await this.options.onWake(wake);
      return await this.options.orchestrator.completeWake(wake.wakeId) ?? wake;
    } catch (error) {
      const failed = await this.options.orchestrator.failWake(wake.wakeId, errorMessage(error));
      this.options.onError?.(error, wake);
      return failed ?? wake;
    }
  }
}

