// ============================================================
// @berry-agent/a8s-server — Team store (project-scoped)
// ============================================================
//
// The emergent Team's shared state lives here, in a8s, not in any leader's
// local `project/.berry/` files (which don't exist under brain-hand
// separation — the leader is a cloud agent). A team is the set of agents
// sharing a `project` label; this store holds, per project:
//   - a worklist (tasks the leader hands out, teammates claim + update)
//   - a message log (append-only; message_leader / message_teammate land here
//     and are also delivered live via a8s wakes)
//
// Membership is NOT stored — it's computed from listAgents + labels.project.
// Persistence mirrors HandRecipeStore: one JSON file, in-memory cache, atomic
// tmp+rename write (single a8s process per store path).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  worklistTaskSchema,
  teamMessageSchema,
  type WorklistTask,
  type WorklistCreateRequest,
  type WorklistPatchRequest,
  type TeamMessage,
  type TeamMessageAppendRequest,
} from '@berry-agent/cluster-protocol';

export interface TeamStoreOptions {
  /** Path to the JSON file holding all projects' team state. */
  filePath: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Injectable clock + id source (tests). Defaults to Date.now + counter. */
  now?: () => number;
}

interface ProjectState {
  worklist: WorklistTask[];
  messages: TeamMessage[];
}
interface PersistedShape {
  projects: Record<string, ProjectState>;
  updatedAt: number;
}

export class TeamStore {
  private readonly filePath: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;
  private projects = new Map<string, ProjectState>();
  private loaded = false;
  private seq = 0;

  constructor(options: TeamStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShape;
      const next = new Map<string, ProjectState>();
      for (const [project, state] of Object.entries(parsed.projects ?? {})) {
        next.set(project, {
          worklist: (state.worklist ?? []).map((t) => worklistTaskSchema.parse(t)),
          messages: (state.messages ?? []).map((m) => teamMessageSchema.parse(m)),
        });
      }
      this.projects = next;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        this.logger.warn?.(`[team-store] read failed: ${(err as Error).message}`);
      }
      this.projects = new Map();
    }
    this.loaded = true;
  }

  private state(project: string): ProjectState {
    let s = this.projects.get(project);
    if (!s) {
      s = { worklist: [], messages: [] };
      this.projects.set(project, s);
    }
    return s;
  }

  /** Monotonic unique suffix so ids stay unique even within one ms. */
  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.now().toString(36)}-${this.seq.toString(36)}`;
  }

  // ----- worklist -----

  async listWorklist(project: string): Promise<WorklistTask[]> {
    await this.ensureLoaded();
    return [...this.state(project).worklist];
  }

  async addTask(project: string, req: WorklistCreateRequest): Promise<WorklistTask> {
    await this.ensureLoaded();
    const ts = this.now();
    const task: WorklistTask = worklistTaskSchema.parse({
      id: this.nextId('T'),
      title: req.title,
      description: req.description,
      status: req.assignee ? 'claimed' : 'unclaimed',
      assignee: req.assignee,
      createdBy: req.createdBy,
      createdAt: ts,
      updatedAt: ts,
    });
    this.state(project).worklist.push(task);
    await this.persist();
    return task;
  }

  /** Patch a task (claim / status / assignee / failure). Null if not found. */
  async patchTask(project: string, taskId: string, patch: WorklistPatchRequest): Promise<WorklistTask | null> {
    await this.ensureLoaded();
    const list = this.state(project).worklist;
    const idx = list.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;
    const prev = list[idx];
    const ts = this.now();
    const next: WorklistTask = worklistTaskSchema.parse({
      ...prev,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      updatedAt: ts,
      ...(patch.status === 'done' ? { completedAt: ts } : {}),
    });
    list[idx] = next;
    await this.persist();
    return next;
  }

  // ----- messages -----

  async listMessages(project: string): Promise<TeamMessage[]> {
    await this.ensureLoaded();
    return [...this.state(project).messages];
  }

  async appendMessage(project: string, req: TeamMessageAppendRequest): Promise<TeamMessage> {
    await this.ensureLoaded();
    const msg: TeamMessage = teamMessageSchema.parse({
      id: this.nextId('M'),
      ts: this.now(),
      from: req.from,
      to: req.to,
      content: req.content,
      replyTo: req.replyTo,
    });
    this.state(project).messages.push(msg);
    await this.persist();
    return msg;
  }

  private async persist(): Promise<void> {
    const record: PersistedShape = {
      projects: Object.fromEntries(this.projects),
      updatedAt: this.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.seq}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }
}
