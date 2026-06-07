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

import { appendFile, mkdir, readFile } from 'node:fs/promises';
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

  /**
   * Read back recent audit entries, newest first. Reads the per-day JSONL
   * files spanning [from, to], parses each line, filters, and caps at `limit`.
   * Best-effort: a missing day file (no actions that day) is skipped silently;
   * a malformed line is dropped. Returns `{ entries, truncated }`.
   *
   * This is the read side of the append-only log — the operator's Audit page
   * calls it. It deliberately reads the files (not a DB) to stay consistent
   * with the "files are the fact source" rule the writer follows.
   */
  async query(opts: AuditQueryOptions = {}): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    const to = opts.to ?? Date.now();
    // Default window: 7 days back, so the page isn't empty on first open.
    const from = opts.from ?? to - 7 * 24 * 60 * 60 * 1000;
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);

    // Collect the day files covering [from, to] (inclusive), newest day first.
    const days: string[] = [];
    const oneDay = 24 * 60 * 60 * 1000;
    // Walk by calendar day from `to` back to `from`.
    for (let t = to; t >= from - oneDay; t -= oneDay) {
      const day = new Date(t).toISOString().slice(0, 10);
      if (!days.includes(day)) days.push(day);
    }

    const matched: AuditEntry[] = [];
    let truncated = false;
    for (const day of days) {
      let raw: string;
      try {
        raw = await readFile(join(this.auditRoot, `audit.${day}.jsonl`), 'utf-8');
      } catch {
        continue; // no file for this day
      }
      const lines = raw.split('\n');
      // Newest first within a day: iterate bottom-up.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          continue; // drop malformed line
        }
        if (typeof entry.ts !== 'number' || entry.ts < from || entry.ts > to) continue;
        if (opts.action && entry.action !== opts.action) continue;
        if (opts.outcome && entry.outcome !== opts.outcome) continue;
        matched.push(entry);
        if (matched.length >= limit) { truncated = true; break; }
      }
      if (truncated) break;
    }
    return { entries: matched, truncated };
  }
}

/** Filters for {@link AuditLog.query}. */
export interface AuditQueryOptions {
  /** Lower bound (Unix ms), inclusive. Default: 7 days before `to`. */
  from?: number;
  /** Upper bound (Unix ms), inclusive. Default: now. */
  to?: number;
  /** Only this action verb. */
  action?: string;
  /** Only this outcome. */
  outcome?: 'ok' | 'err';
  /** Max rows (1–2000). Default 200. */
  limit?: number;
}

/** No-op audit log for tests / dev. */
export class NullAuditLog extends AuditLog {
  constructor() {
    super({ auditRoot: '/dev/null' });
  }
  async log(_entry: AuditEntry): Promise<void> {
    // intentionally empty
  }
  async query(): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    return { entries: [], truncated: false };
  }
}
