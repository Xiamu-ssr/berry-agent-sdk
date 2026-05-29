// ============================================================
// @berry-agent/a8s-server — Audit log
// ============================================================
//
// Append-only JSONL of operator actions: every mutating control-plane
// op (worker drain/undrain/evict, agent create/delete, wake schedule/
// cancel, join-script issuance) gets a row. Follows the same "files
// are fact source" rule as events.jsonl — we use a file, not the
// orchestration DB, so a) operators can `tail -f` it without a SQL
// client and b) audit history outlives any single orch.db generation.
//
// One file per a8s instance, lives at <auditRoot>/audit.jsonl. Rolls
// daily for tractability (audit.YYYY-MM-DD.jsonl), with a stable
// `audit.jsonl` symlink to the current day.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AuditEntry {
  /** Unix ms timestamp. */
  ts: number;
  /** Stable action verb, e.g. 'worker.drain', 'agent.create'. */
  action: string;
  /** Who: 'admin-token' for product/operator, 'worker:<id>' for worker self-actions. */
  actor: string;
  /** Source IP if known (proxy may obscure; best-effort). */
  sourceIp?: string;
  /** Target of the action — agentId, workerId, wakeId, etc. */
  target?: string;
  /** Outcome: 'ok' for success, 'err' for failure (HTTP non-2xx response or thrown). */
  outcome: 'ok' | 'err';
  /** Free-form context (operator-visible). */
  details?: Record<string, unknown>;
}

export interface AuditLogOptions {
  /** Directory to put audit.jsonl in. Auto-created. */
  auditRoot: string;
  /** Logger for write failures (audit must never crash the request path). */
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class AuditLog {
  private readonly auditRoot: string;
  private readonly logger: Pick<Console, 'warn' | 'error'>;
  private ensured = false;

  constructor(options: AuditLogOptions) {
    this.auditRoot = options.auditRoot;
    this.logger = options.logger ?? console;
  }

  /**
   * Best-effort append. Audit failures never propagate — the worst
   * outcome of a missing row is that an operator action isn't recorded,
   * which is preferable to denying the action itself.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      if (!this.ensured) {
        await mkdir(this.auditRoot, { recursive: true });
        this.ensured = true;
      }
      const line = JSON.stringify(entry) + '\n';
      await appendFile(this.dayFile(), line, 'utf-8');
    } catch (err) {
      this.logger.warn?.('[audit] write failed:', err);
    }
  }

  /** Path of the file the current day's entries write to. */
  dayFile(now = Date.now()): string {
    const day = new Date(now).toISOString().slice(0, 10);
    return join(this.auditRoot, `audit.${day}.jsonl`);
  }
}

/** No-op audit log for tests / dev. */
export class NullAuditLog extends AuditLog {
  constructor() {
    super({ auditRoot: '/dev/null' });
  }
  async log(_entry: AuditEntry): Promise<void> {
    // intentionally empty
  }
}
