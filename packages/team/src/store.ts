/**
 * TeamStore — persistence for team state + message log.
 *
 * Storage layout (all under project/.berry/):
 *   team.json          — TeamState snapshot (single team per project in v1).
 *   messages.jsonl     — append-only TeamMessage log.
 *
 * Rationale:
 *   - team.json is small, read/write as a whole on every mutation.
 *   - messages.jsonl grows with interactions, so append-only JSONL beats
 *     rewriting a JSON array.
 *   - Both live under the project (shared across hosts) rather than in the
 *     host app's config, because a team *is* project-scoped — cloning the
 *     project should come with the team.
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { TeamMessage, TeamState } from './types.js';

const BERRY_DIR = '.berry';
const TEAM_FILE = 'team.json';
const MESSAGES_FILE = 'messages.jsonl';

export class TeamStore {
  readonly project: string;
  readonly berryDir: string;

  constructor(project: string) {
    this.project = project;
    this.berryDir = join(project, BERRY_DIR);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.berryDir)) {
      await mkdir(this.berryDir, { recursive: true });
    }
  }

  /** Load the team snapshot, or null if no team exists in this project. */
  async load(): Promise<TeamState | null> {
    const path = join(this.berryDir, TEAM_FILE);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as TeamState;
  }

  /** Atomically replace the team snapshot. */
  async save(state: TeamState): Promise<void> {
    await this.ensureDir();
    const path = join(this.berryDir, TEAM_FILE);
    // Write to temp then rename = atomic on POSIX; prevents partial writes
    // corrupting the file if the process dies mid-save (the same pitfall
    // that bit us in berry-claw ConfigManager last week).
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  }

  /** Append one message to the log. */
  async appendMessage(msg: TeamMessage): Promise<void> {
    await this.ensureDir();
    const path = join(this.berryDir, MESSAGES_FILE);
    await appendFile(path, JSON.stringify(msg) + '\n', 'utf-8');
  }

  /**
   * Read the entire message log. Fine for v1 (teams are small, messages
   * are short). If this ever grows unbounded, add pagination / tail.
   */
  async readMessages(): Promise<TeamMessage[]> {
    const path = join(this.berryDir, MESSAGES_FILE);
    if (!existsSync(path)) return [];
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TeamMessage);
  }
}
