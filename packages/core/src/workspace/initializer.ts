// ============================================================
// Berry Agent SDK — Workspace Initializer
// ============================================================

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Agent metadata stored in agent.json. */
export interface AgentMetadata {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * Initialize an agent workspace directory.
 *
 * Creates:
 * ```
 * {root}/
 *   ├── agent.json      (metadata: { id, name, createdAt })
 *   ├── AGENT.md        (empty system prompt template)
 *   ├── MEMORY.md       (empty)
 *   └── .berry/
 *       └── sessions/   (for JSONL event logs)
 * ```
 *
 * Idempotent: skips if `agent.json` already exists.
 *
 * @returns The agent metadata (existing or newly created).
 */
export async function initWorkspace(root: string): Promise<AgentMetadata> {
  const agentJsonPath = join(root, 'agent.json');

  // Check if already initialized
  try {
    await access(agentJsonPath);
    // Already exists — read and return
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(agentJsonPath, 'utf-8');
    return JSON.parse(raw) as AgentMetadata;
  } catch {
    // Not initialized yet — continue
  }

  // Create directory structure
  await mkdir(join(root, '.berry', 'sessions'), { recursive: true });

  // Generate agent ID from directory name
  const id = slugify(basename(root));
  const metadata: AgentMetadata = {
    id,
    name: basename(root),
    createdAt: new Date().toISOString(),
  };

  // Write files
  await Promise.all([
    writeFile(agentJsonPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8'),
    writeFile(join(root, 'AGENT.md'), '', 'utf-8'),
    writeFile(join(root, 'MEMORY.md'), '', 'utf-8'),
  ]);

  return metadata;
}

/** Convert a directory name to a URL-friendly slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'agent';
}
