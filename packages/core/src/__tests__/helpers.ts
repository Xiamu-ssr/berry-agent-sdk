// ============================================================
// Test helpers
// ============================================================
// Small shared utilities for unit tests. Kept deliberately minimal —
// anything non-obvious should live in a dedicated test module.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHome } from '../agent-home.js';
import { SystemPromptCacheMode, type SystemPromptBlock } from '../types.js';

/**
 * Create a fresh `AgentHome` rooted at a unique OS temp directory.
 * Use inside tests that construct `new Agent({ home: ... })` — avoids
 * every call site repeating the same mkdtempSync boilerplate.
 */
export function tmpHome(prefix = 'berry-test-'): AgentHome {
  return new AgentHome(mkdtempSync(join(tmpdir(), prefix)));
}

export function stablePrompt(...texts: string[]): SystemPromptBlock[] {
  return texts.map((text) => ({ text, cache: SystemPromptCacheMode.Stable }));
}
