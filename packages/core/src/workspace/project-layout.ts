// ============================================================
// Berry Agent SDK — Project Shared Layout
// ============================================================

import { join } from 'node:path';

/** The single project-level context file. Humans maintain it; agents read only. */
export const PROJECT_CONTEXT_FILE = 'AGENTS.md' as const;

/** SDK-owned project collaboration directory. Host products should not invent paths under it. */
export const PROJECT_BERRY_DIR = '.berry' as const;
export const PROJECT_TEAM_FILE = 'team.json' as const;
export const PROJECT_TEAM_MESSAGES_FILE = 'messages.jsonl' as const;
export const PROJECT_WORKLIST_FILE = 'worklist.json' as const;
export const PROJECT_SAFETY_FILE = 'safety.json' as const;

export interface ProjectSharedPaths {
  root: string;
  contextPath: string;
  berryDir: string;
  teamPath: string;
  teamMessagesPath: string;
  worklistPath: string;
  safetyPath: string;
}

/** Resolve every SDK-managed shared project path from a single project root. */
export function projectSharedPaths(projectRoot: string): ProjectSharedPaths {
  const berryDir = join(projectRoot, PROJECT_BERRY_DIR);
  return {
    root: projectRoot,
    contextPath: join(projectRoot, PROJECT_CONTEXT_FILE),
    berryDir,
    teamPath: join(berryDir, PROJECT_TEAM_FILE),
    teamMessagesPath: join(berryDir, PROJECT_TEAM_MESSAGES_FILE),
    worklistPath: join(berryDir, PROJECT_WORKLIST_FILE),
    safetyPath: join(berryDir, PROJECT_SAFETY_FILE),
  };
}
