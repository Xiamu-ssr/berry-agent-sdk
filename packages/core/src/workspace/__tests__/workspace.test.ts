import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace, type AgentMetadata } from '../initializer.js';
import { FileAgentMemory } from '../file-memory.js';
import { FileProjectContext } from '../file-project.js';

// ===== initWorkspace =====

describe('initWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'berry-ws-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates workspace structure with all expected files', async () => {
    await initWorkspace(root);

    // Verify all files exist
    await access(join(root, 'agent.json'));
    await access(join(root, 'AGENT.md'));
    await access(join(root, 'MEMORY.md'));
    await access(join(root, '.berry', 'sessions'));
  });

  it('returns agent metadata with correct fields', async () => {
    const meta = await initWorkspace(root);

    expect(meta.id).toBeTruthy();
    expect(meta.name).toBeTruthy();
    expect(meta.createdAt).toBeTruthy();
    // createdAt should be a valid ISO date
    expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
  });

  it('generates slug ID from directory name', async () => {
    const namedDir = join(root, 'My Agent 123');
    await mkdir(namedDir, { recursive: true });
    const meta = await initWorkspace(namedDir);

    expect(meta.id).toBe('my-agent-123');
    expect(meta.name).toBe('My Agent 123');
  });

  it('is idempotent — second call returns existing metadata', async () => {
    const first = await initWorkspace(root);
    const second = await initWorkspace(root);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('persists metadata as valid JSON in agent.json', async () => {
    await initWorkspace(root);
    const raw = await readFile(join(root, 'agent.json'), 'utf-8');
    const parsed = JSON.parse(raw) as AgentMetadata;
    expect(parsed.id).toBeTruthy();
    expect(parsed.name).toBeTruthy();
  });
});

// ===== FileAgentMemory =====

describe('FileAgentMemory', () => {
  let root: string;
  let memory: FileAgentMemory;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'berry-mem-'));
    memory = new FileAgentMemory(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('load() returns empty string when file does not exist', async () => {
    const content = await memory.load();
    expect(content).toBe('');
  });

  it('exists() returns false when file does not exist', async () => {
    expect(await memory.exists()).toBe(false);
  });

  it('write() creates file and load() reads it back', async () => {
    await memory.write('# Memory\n\nSome content.');
    const content = await memory.load();
    expect(content).toBe('# Memory\n\nSome content.');
    expect(await memory.exists()).toBe(true);
  });

  it('append() adds content with timestamp header', async () => {
    await memory.write(''); // create empty file
    await memory.append('First entry');
    await memory.append('Second entry');

    const content = await memory.load();
    expect(content).toContain('First entry');
    expect(content).toContain('Second entry');
    // Should contain ISO date headers
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });

  it('search() finds matching entries in memory markdown', async () => {
    await memory.write('');
    await memory.append('Architecture decision: use JSONL event logs');
    await memory.append('Implementation note: todo lives in session metadata');

    const results = await memory.search('architecture', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Architecture decision');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('write() replaces existing content entirely', async () => {
    await memory.write('original');
    await memory.write('replaced');
    const content = await memory.load();
    expect(content).toBe('replaced');
    expect(content).not.toContain('original');
  });
});

// ===== FileProjectContext =====

describe('FileProjectContext', () => {
  let root: string;
  let ctx: FileProjectContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'berry-proj-'));
    ctx = new FileProjectContext(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loadContext() returns empty string when no context files exist', async () => {
    const content = await ctx.loadContext();
    expect(content).toBe('');
  });

  it('loadContext() reads AGENTS.md when it exists', async () => {
    await writeFile(join(root, 'AGENTS.md'), '# Agents\nTeam guidelines.');
    const content = await ctx.loadContext();
    expect(content).toBe('# Agents\nTeam guidelines.');
  });

  it('loadContext() reads PROJECT.md when AGENTS.md does not exist', async () => {
    await writeFile(join(root, 'PROJECT.md'), '# Project\nProject info.');
    const content = await ctx.loadContext();
    expect(content).toBe('# Project\nProject info.');
  });

  it('loadContext() prefers AGENTS.md over PROJECT.md', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'agents content');
    await writeFile(join(root, 'PROJECT.md'), 'project content');
    const content = await ctx.loadContext();
    expect(content).toBe('agents content');
  });

  it('appendDiscovery() creates .berry-discoveries.md and appends', async () => {
    await ctx.appendDiscovery('Found: API uses REST v2');
    await ctx.appendDiscovery('Found: Auth uses JWT');

    const content = await readFile(join(root, '.berry-discoveries.md'), 'utf-8');
    expect(content).toContain('Found: API uses REST v2');
    expect(content).toContain('Found: Auth uses JWT');
    // Should have timestamp headers
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });

  it('root property reflects project directory', () => {
    expect(ctx.root).toBe(root);
  });
});
