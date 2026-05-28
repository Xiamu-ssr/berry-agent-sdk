import type { Message } from '../content-types.js';
import type { AgentEvent, AgentStatus, QueryOptions } from '../agent-runtime-types.js';
import type { SleepSignal } from './runtime-tools.js';

export interface ActiveAgentTurn {
  controller: AbortController;
  options: QueryOptions;
}

function composeAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (a.aborted) abort(a);
  else a.addEventListener('abort', () => abort(a), { once: true });
  if (b.aborted) abort(b);
  else b.addEventListener('abort', () => abort(b), { once: true });
  return controller.signal;
}

export class AgentRunState {
  private _querying = false;
  private _status: AgentStatus = 'idle';
  private _statusDetail?: string;
  private pendingInterjects: string[] = [];
  private interjectWakers: Array<() => void> = [];
  private sleepDepth = 0;
  private activeAbortController?: AbortController;
  private pausedReason?: string;

  constructor(private readonly emitStatusEvent: (event: AgentEvent) => void) {}

  get status(): AgentStatus {
    return this._status;
  }

  get statusDetail(): string | undefined {
    return this._statusDetail;
  }

  get isDisposed(): boolean {
    return this._status === 'disposed';
  }

  setStatus(status: AgentStatus, detail?: string): void {
    if (this._status === status && this._statusDetail === detail) return;
    this._status = status;
    this._statusDetail = detail;
    this.emitStatusEvent({ type: 'status_change', status, detail });
  }

  interject(text: string): void {
    if (!text || !text.trim()) return;
    this.pendingInterjects.push(text);
    this.wakeInterjectWaiters();
  }

  pause(reason = 'paused by host'): boolean {
    if (!this._querying || !this.activeAbortController || this.activeAbortController.signal.aborted) {
      return false;
    }
    this.pausedReason = reason;
    this.activeAbortController.abort(new Error(reason));
    this.setStatus('paused', reason);
    return true;
  }

  startAbortableTurn(options?: QueryOptions): ActiveAgentTurn {
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.pausedReason = undefined;
    return {
      controller,
      options: {
        ...(options ?? {}),
        abortSignal: composeAbortSignals(options?.abortSignal, controller.signal),
      },
    };
  }

  markQuerying(detail = 'thinking'): void {
    this._querying = true;
    this.setStatus('tool_use', detail);
  }

  pausedReasonFor(controller: AbortController): string | undefined {
    return controller.signal.aborted ? this.pausedReason : undefined;
  }

  finishAbortableTurn(controller: AbortController, pausedReason?: string): void {
    this._querying = false;
    if (this.activeAbortController === controller) {
      this.activeAbortController = undefined;
    }
    if (!this.isDisposed) {
      if (pausedReason) this.setStatus('paused', pausedReason);
      else this.setStatus('idle');
    }
  }

  createSleepSignal(): SleepSignal {
    return {
      onEnter: () => {
        this.sleepDepth++;
        this.setStatus('sleeping');
      },
      onExit: () => {
        this.sleepDepth = Math.max(0, this.sleepDepth - 1);
        if (this.sleepDepth === 0 && this._status === 'sleeping') {
          this.setStatus('tool_use');
        }
      },
      interjectWaker: () => new Promise<void>((resolve) => {
        if (this.pendingInterjects.length > 0) {
          resolve();
          return;
        }
        this.interjectWakers.push(resolve);
      }),
    };
  }

  drainInterjects(): Message[] {
    if (this.pendingInterjects.length === 0) return [];
    const texts = this.pendingInterjects.splice(0);
    return texts.map((text) => ({
      role: 'user' as const,
      content: text,
      createdAt: Date.now(),
    }));
  }

  abortActiveTurn(reason: string): void {
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(new Error(reason));
    }
  }

  clearInterjects(): void {
    this.pendingInterjects = [];
    this.wakeInterjectWaiters();
  }

  private wakeInterjectWaiters(): void {
    const wakers = this.interjectWakers.splice(0);
    for (const wake of wakers) {
      try {
        wake();
      } catch {
        // ignore listener failures
      }
    }
  }
}
