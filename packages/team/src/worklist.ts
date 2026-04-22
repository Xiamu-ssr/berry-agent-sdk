/**
 * Worklist — shared task board for a team.
 *
 * Storage: project/.berry/worklist.json (small JSON, atomic rewrite per
 * mutation — same approach as team.json, no JSONL needed because we mutate
 * individual rows and readers want the current snapshot, not history).
 *
 * State machine (enforced on every mutation, not left to prompting):
 *
 *     unclaimed ──claim──▶ claimed ──start──▶ in_progress ──complete──▶ done
 *                                                         └──fail────▶ failed
 *
 * Role model:
 *   - Leader: full CRUD + can force any status via `update` (for when a
 *     teammate goes off the rails and the leader needs to reset).
 *   - Teammate: create tasks (self-assigned), claim unclaimed tasks, move
 *     own tasks along the happy path (start/complete/fail). Cannot touch
 *     tasks assigned to someone else.
 *
 * Why a single tool with `action` (not 5 separate tools): token budget in
 * the leader's system prompt is precious, and LLMs do well with multi-
 * action tools (cf. `bash`, `str_replace_editor`). Adding actions later
 * doesn't require new registrations.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  TeammateId,
  WorklistState,
  WorklistTask,
  WorklistTaskStatus,
} from './types.js';

const BERRY_DIR = '.berry';
const WORKLIST_FILE = 'worklist.json';

/** Thrown on illegal state transitions and permission violations. */
export class WorklistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorklistError';
  }
}

export type WorklistActor = TeammateId | '@leader';

export class WorklistStore {
  readonly project: string;
  readonly berryDir: string;
  private _state: WorklistState | null = null;

  constructor(project: string) {
    this.project = project;
    this.berryDir = join(project, BERRY_DIR);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.berryDir)) {
      await mkdir(this.berryDir, { recursive: true });
    }
  }

  /** Load-or-create. First call on a fresh project returns an empty state. */
  async load(): Promise<WorklistState> {
    if (this._state) return this._state;
    const path = join(this.berryDir, WORKLIST_FILE);
    if (!existsSync(path)) {
      this._state = { tasks: [], nextId: 1, updatedAt: Date.now() };
      return this._state;
    }
    const raw = await readFile(path, 'utf-8');
    this._state = JSON.parse(raw) as WorklistState;
    return this._state;
  }

  private async save(): Promise<void> {
    if (!this._state) return;
    await this.ensureDir();
    const path = join(this.berryDir, WORKLIST_FILE);
    const tmp = `${path}.tmp`;
    this._state.updatedAt = Date.now();
    await writeFile(tmp, JSON.stringify(this._state, null, 2), 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  }

  // ======================= Actor-aware operations =======================

  async list(): Promise<WorklistTask[]> {
    const s = await this.load();
    return s.tasks.slice();
  }

  async get(id: string): Promise<WorklistTask | undefined> {
    const s = await this.load();
    return s.tasks.find((t) => t.id === id);
  }

  /** Create a task. Leaders create unclaimed-by-default; teammates self-assign by default. */
  async create(
    actor: WorklistActor,
    input: { title: string; description?: string; assignee?: WorklistActor; tags?: string[] },
  ): Promise<WorklistTask> {
    if (!input.title?.trim()) {
      throw new WorklistError('Task title is required.');
    }
    const s = await this.load();
    const id = `T-${String(s.nextId).padStart(4, '0')}`;
    s.nextId += 1;

    // Default assignee rule: leader-created tasks are unclaimed (for the
    // team to pick up); teammate-created tasks default to self (they're
    // typically capturing their own follow-ups).
    const assignee = input.assignee ?? (actor === '@leader' ? undefined : actor);
    const status: WorklistTaskStatus = assignee ? 'claimed' : 'unclaimed';

    const now = Date.now();
    const task: WorklistTask = {
      id,
      title: input.title.trim(),
      description: input.description,
      status,
      assignee,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
    };
    s.tasks.push(task);
    await this.save();
    return task;
  }

  /** Leader-only generic update. Lets the leader force any status or reassign. */
  async update(
    actor: WorklistActor,
    id: string,
    patch: Partial<Pick<WorklistTask, 'title' | 'description' | 'assignee' | 'status' | 'tags' | 'failureReason'>>,
  ): Promise<WorklistTask> {
    if (actor !== '@leader') {
      throw new WorklistError('Only the leader can use `update` directly. Teammates must use claim/start/complete/fail.');
    }
    const s = await this.load();
    const task = s.tasks.find((t) => t.id === id);
    if (!task) throw new WorklistError(`Task ${id} not found.`);
    Object.assign(task, patch);
    task.updatedAt = Date.now();
    if (patch.status === 'done' && !task.completedAt) task.completedAt = task.updatedAt;
    if (patch.status === 'failed' && !task.failureReason) task.failureReason = patch.failureReason ?? 'unspecified';
    await this.save();
    return task;
  }

  async remove(actor: WorklistActor, id: string): Promise<void> {
    if (actor !== '@leader') {
      throw new WorklistError('Only the leader can delete tasks.');
    }
    const s = await this.load();
    const idx = s.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new WorklistError(`Task ${id} not found.`);
    s.tasks.splice(idx, 1);
    await this.save();
  }

  /** Teammate claims an unclaimed task. */
  async claim(actor: WorklistActor, id: string): Promise<WorklistTask> {
    return this.transitionOwn(actor, id, {
      expect: (t) => t.status === 'unclaimed' || (t.status === 'claimed' && t.assignee === actor),
      apply: (t) => {
        t.status = 'claimed';
        t.assignee = actor;
      },
      err: (t) => `Task ${id} can't be claimed (current status: ${t.status}, assignee: ${t.assignee ?? 'none'}).`,
      requireOwnership: false, // claiming is the point where ownership transfers
    });
  }

  async start(actor: WorklistActor, id: string): Promise<WorklistTask> {
    return this.transitionOwn(actor, id, {
      expect: (t) => t.status === 'claimed',
      apply: (t) => { t.status = 'in_progress'; },
      err: (t) => `Task ${id} must be claimed before starting (current: ${t.status}).`,
    });
  }

  async complete(actor: WorklistActor, id: string): Promise<WorklistTask> {
    return this.transitionOwn(actor, id, {
      expect: (t) => t.status === 'in_progress',
      apply: (t) => {
        t.status = 'done';
        t.completedAt = Date.now();
      },
      err: (t) => `Task ${id} must be in_progress before completing (current: ${t.status}).`,
    });
  }

  async fail(actor: WorklistActor, id: string, reason: string): Promise<WorklistTask> {
    if (!reason?.trim()) throw new WorklistError('A failure reason is required.');
    return this.transitionOwn(actor, id, {
      expect: (t) => t.status === 'in_progress' || t.status === 'claimed',
      apply: (t) => {
        t.status = 'failed';
        t.failureReason = reason.trim();
      },
      err: (t) => `Task ${id} must be claimed or in_progress to fail it (current: ${t.status}).`,
    });
  }

  /**
   * Shared helper: guard by ownership + expected state, mutate, save.
   * Leaders bypass ownership; for them, use `update` directly instead.
   */
  private async transitionOwn(
    actor: WorklistActor,
    id: string,
    opts: {
      expect: (t: WorklistTask) => boolean;
      apply: (t: WorklistTask) => void;
      err: (t: WorklistTask) => string;
      /** Default: require actor === task.assignee. */
      requireOwnership?: boolean;
    },
  ): Promise<WorklistTask> {
    const s = await this.load();
    const task = s.tasks.find((t) => t.id === id);
    if (!task) throw new WorklistError(`Task ${id} not found.`);

    const ownershipRequired = opts.requireOwnership !== false;
    if (ownershipRequired && task.assignee && task.assignee !== actor && actor !== '@leader') {
      throw new WorklistError(
        `Task ${id} is assigned to ${task.assignee}; you are ${actor}. Use another action or ask the leader to reassign.`,
      );
    }
    if (!opts.expect(task)) {
      throw new WorklistError(opts.err(task));
    }
    opts.apply(task);
    task.updatedAt = Date.now();
    await this.save();
    return task;
  }
}
