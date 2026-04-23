// ============================================================
// Tests: save_memory + save_discovery runtime tools
// ============================================================
// These tools make agent memory + project knowledge writable FROM
// INSIDE THE LOOP. Without them the only way anything got into those
// files was preCompactMemoryFlush (automatic, at compaction time).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.js';
import type { Provider } from '../providers/types.js';

// Minimal mock provider that just returns a pre-scripted sequence.
class SequenceProvider implements Provider {
  private i = 0;
  constructor(private responses: Array<Parameters<Provider['chat']>[0] extends unknown ? any : never>) {}
  async chat(): Promise<any> {
    if (this.i >= this.responses.length) {
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: mkUsage() };
    }
    return this.responses[this.i++];
  }
  name = 'mock';
}

function mkUsage() {
  return { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

describe('save_memory + save_discovery tools', () => {
  let workspace: string;
  let project: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'berry-save-memory-ws-'));
    project = await mkdtemp(join(tmpdir(), 'berry-save-memory-proj-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('does NOT register save_memory without workspace', () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'x', model: 'm' },
      providerInstance: new SequenceProvider([]),
      systemPrompt: 's',
    });
    const names = agent.getTools().map((t) => t.name);
    expect(names).not.toContain('save_memory');
  });

  it('save_memory appends to MEMORY.md', async () => {
    // The provider will call save_memory once, then end the turn.
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'save_memory', input: { content: 'user prefers tabs' } },
        ],
        stopReason: 'tool_use',
        usage: mkUsage(),
      },
      { content: [{ type: 'text', text: 'saved' }], stopReason: 'end_turn', usage: mkUsage() },
    ]);
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'x', model: 'm' },
      providerInstance: provider,
      systemPrompt: 's',
      workspace,
    });
    await agent.query('remember tabs');
    const mem = await readFile(join(workspace, 'MEMORY.md'), 'utf-8');
    expect(mem).toContain('user prefers tabs');
  });

  it('save_discovery appends to {project}/.berry-discoveries.md', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'save_discovery', input: { content: 'API uses snake_case' } },
        ],
        stopReason: 'tool_use',
        usage: mkUsage(),
      },
      { content: [{ type: 'text', text: 'saved' }], stopReason: 'end_turn', usage: mkUsage() },
    ]);
    // Pre-create an AGENTS.md so projectContext has something to load (not
    // strictly needed by the tool; asserts projectDir binding works end-to-end).
    await writeFile(join(project, 'AGENTS.md'), '# Project notes\n', 'utf-8');
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'x', model: 'm' },
      providerInstance: provider,
      systemPrompt: 's',
      workspace,
      project,
    });
    await agent.query('remember the naming');
    const disc = await readFile(join(project, '.berry-discoveries.md'), 'utf-8');
    expect(disc).toContain('API uses snake_case');
  });

  it('save_memory rejects empty content', async () => {
    const provider = new SequenceProvider([
      {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'save_memory', input: { content: '   ' } },
        ],
        stopReason: 'tool_use',
        usage: mkUsage(),
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: mkUsage() },
    ]);
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'x', model: 'm' },
      providerInstance: provider,
      systemPrompt: 's',
      workspace,
    });
    await agent.query('nothing');
    // Tool returned error, so nothing appended beyond the file's initial
    // (empty) state. initWorkspace() creates an empty MEMORY.md up front.
    const mem = await readFile(join(workspace, 'MEMORY.md'), 'utf-8');
    expect(mem.trim()).toBe('');
  });
});
