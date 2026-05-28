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
import { mkdir, readFile, appendFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  parseJsonWithSchema,
  projectSharedPaths,
  writeJsonAtomic,
  type ProjectSharedPaths,
} from '@berry-agent/core';
import type { TeamMessage, TeamState } from './types.js';
import { zTeamMessage, zTeamState } from './schema.js';

export class TeamStore {
  readonly project: string;
  readonly berryDir: string;
  readonly paths: ProjectSharedPaths;

  constructor(project: string) {
    this.project = project;
    this.paths = projectSharedPaths(project);
    this.berryDir = this.paths.berryDir;
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.berryDir)) {
      await mkdir(this.berryDir, { recursive: true });
    }
  }

  /** Load the team snapshot, or null if no team exists in this project. */
  async load(): Promise<TeamState | null> {
    const path = this.paths.teamPath;
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    return parseJsonWithSchema(raw, zTeamState, `team snapshot "${path}"`);
  }

  /** Atomically replace the team snapshot. */
  async save(state: TeamState): Promise<void> {
    const snapshot = zTeamState.parse(state);
    await writeJsonAtomic(this.paths.teamPath, snapshot);
  }

  /** Append one message to the log. */
  async appendMessage(msg: TeamMessage): Promise<void> {
    await this.ensureDir();
    const path = this.paths.teamMessagesPath;
    await appendFile(path, JSON.stringify(zTeamMessage.parse(msg)) + '\n', 'utf-8');
  }

  /**
   * Read the entire message log. Fine for v1 (teams are small, messages
   * are short). If this ever grows unbounded, add pagination / tail.
   */
  async readMessages(): Promise<TeamMessage[]> {
    const path = this.paths.teamMessagesPath;
    if (!existsSync(path)) return [];
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, idx) => parseJsonWithSchema(line, zTeamMessage, `team message log "${path}" line ${idx + 1}`));
  }

  /** Delete team-owned snapshot and message-log artifacts. */
  async deleteArtifacts(): Promise<void> {
    await Promise.all([
      rm(this.paths.teamPath, { force: true }),
      rm(this.paths.teamMessagesPath, { force: true }),
    ]);
  }
}

/** Read the leader id for a project-scoped team without opening/mutating it. */
export async function readTeamLeaderId(project: string): Promise<string | null> {
  const state = await new TeamStore(project).load();
  return state?.leaderId ?? null;
}
