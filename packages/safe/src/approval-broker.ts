import { randomUUID } from 'node:crypto';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type AskAnswer,
  type AskBridge,
  type AskQuestion,
} from './guards/ask-list.js';

export interface PendingApproval {
  id: string;
  question: AskQuestion;
  createdAt: number;
}

export interface ApprovalBrokerOptions {
  now?: () => number;
  id?: () => string;
  timeoutMs?: number;
  onAsk?: (approval: PendingApproval) => void;
  onResolve?: (approval: PendingApproval, answer: AskAnswer) => void;
}

interface PendingApprovalEntry extends PendingApproval {
  resolve: (answer: AskAnswer) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Transport-neutral broker for human approval questions.
 *
 * Products provide the notification transport through `onAsk` and answer
 * questions through `answer()`. The SDK safety guard only sees `askBridge`,
 * so pending lifecycle, timeout cleanup, and reconnect snapshots live with
 * the safety domain instead of product server glue.
 */
export class ApprovalBroker {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly timeoutMs: number;
  private readonly onAsk?: (approval: PendingApproval) => void;
  private readonly onResolve?: (approval: PendingApproval, answer: AskAnswer) => void;
  private readonly pending = new Map<string, PendingApprovalEntry>();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.onAsk = options.onAsk;
    this.onResolve = options.onResolve;
  }

  readonly askBridge: AskBridge = (question) => this.ask(question);

  ask(question: AskQuestion): Promise<AskAnswer> {
    return new Promise<AskAnswer>((resolve) => {
      const entry: PendingApprovalEntry = {
        id: this.id(),
        question,
        createdAt: this.now(),
        resolve,
      };

      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.answer(entry.id, {
            approved: false,
            note: `timed out after ${this.timeoutMs}ms`,
          });
        }, this.timeoutMs);
      }

      this.pending.set(entry.id, entry);
      this.onAsk?.(snapshot(entry));
    });
  }

  answer(id: string, answer: AskAnswer): PendingApproval | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const approval = snapshot(entry);
    entry.resolve(answer);
    this.onResolve?.(approval, answer);
    return approval;
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map(snapshot);
  }

  clear(answer: AskAnswer = { approved: false, note: 'approval broker cleared' }): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.answer(id, answer);
    return ids.length;
  }
}

function snapshot(entry: PendingApprovalEntry): PendingApproval {
  return {
    id: entry.id,
    question: entry.question,
    createdAt: entry.createdAt,
  };
}
