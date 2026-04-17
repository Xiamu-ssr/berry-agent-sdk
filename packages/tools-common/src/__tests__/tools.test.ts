import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools, createShellTool, createShellTools, createSearchTools, createAllTools, createEditFileTool, createWebFetchTool, createWebSearchTool } from '../index.js';

let tmpDir: string;
let siblingDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'berry-tools-test-'));
  siblingDir = `${tmpDir}-evil`;
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(tmpDir, 'hello.txt'), 'Hello World\nSecond line\nThird line');
  await writeFile(join(tmpDir, 'src/code.ts'), 'const x = 42;\nexport default x;');
  await writeFile(join(siblingDir, 'secret.txt'), 'top-secret');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(siblingDir, { recursive: true, force: true });
});

describe('File tools', () => {
  it('read_file reads content', async () => {
    const tools = createFileTools(tmpDir);
    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readFile.execute({ path: 'hello.txt' }, { cwd: tmpDir });
    expect(result.content).toContain('Hello World');
  });

  it('read_file with offset and limit', async () => {
    const tools = createFileTools(tmpDir);
    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readFile.execute({ path: 'hello.txt', offset: 2, limit: 1 }, { cwd: tmpDir });
    expect(result.content).toContain('Second line');
  });

  it('read_file error on missing file', async () => {
    const tools = createFileTools(tmpDir);
    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readFile.execute({ path: 'nope.txt' }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
  });

  it('write_file creates file with nested dirs', async () => {
    const tools = createFileTools(tmpDir);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const result = await writeTool.execute({ path: 'deep/nested/file.txt', content: 'Deep!' }, { cwd: tmpDir });
    expect(result.content).toContain('Written');

    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const read = await readFile.execute({ path: 'deep/nested/file.txt' }, { cwd: tmpDir });
    expect(read.content).toBe('Deep!');
  });

  it('list_files shows entries', async () => {
    const tools = createFileTools(tmpDir);
    const listTool = tools.find(t => t.definition.name === 'list_files')!;
    const result = await listTool.execute({ path: '.' }, { cwd: tmpDir });
    expect(result.content).toContain('hello.txt');
    expect(result.content).toContain('src');
  });

  it('path traversal blocked', async () => {
    const tools = createFileTools(tmpDir);
    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readFile.execute({ path: '../../etc/passwd' }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes');
  });

  it('blocks sibling paths that only share the baseDir prefix', async () => {
    const tools = createFileTools(tmpDir);
    const readFile = tools.find(t => t.definition.name === 'read_file')!;
    const result = await readFile.execute({ path: `../${basename(siblingDir)}/secret.txt` }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes');
  });
});

describe('Shell tool', () => {
  it('executes and returns output', async () => {
    const tool = createShellTool(tmpDir);
    const result = await tool.execute({ command: 'echo "hello-berry"' }, { cwd: tmpDir });
    expect(result.content).toContain('hello-berry');
  });

  it('returns error for failing command', async () => {
    const tool = createShellTool(tmpDir);
    const result = await tool.execute({ command: 'exit 1' }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
  });

  it('blocks specified commands', async () => {
    const tool = createShellTool(tmpDir, { blockedCommands: ['rm'] });
    const result = await tool.execute({ command: 'rm -rf /' }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('blocked');
  });

  it('supports first-stage background process management', async () => {
    const tools = createShellTools(tmpDir);
    const shell = tools.find(t => t.definition.name === 'shell')!;
    const processList = tools.find(t => t.definition.name === 'process_list')!;
    const processPoll = tools.find(t => t.definition.name === 'process_poll')!;
    const processLog = tools.find(t => t.definition.name === 'process_log')!;
    const processWrite = tools.find(t => t.definition.name === 'process_write')!;
    const processKill = tools.find(t => t.definition.name === 'process_kill')!;

    const command = `node -e "process.stdin.setEncoding('utf8');console.log('ready');process.stdin.on('data', chunk => console.log('echo:' + chunk.trim()));setInterval(() => {}, 1000);"`;
    const started = await shell.execute({ command, background: true }, { cwd: tmpDir });
    const { sessionId } = JSON.parse(started.content) as { sessionId: string };
    expect(sessionId).toContain('proc_');

    const listed = JSON.parse((await processList.execute({}, { cwd: tmpDir })).content) as {
      processes: Array<{ id: string }>;
    };
    expect(listed.processes.some(process => process.id === sessionId)).toBe(true);

    let readyLog = '';
    for (let i = 0; i < 40; i++) {
      readyLog = (await processLog.execute({ id: sessionId }, { cwd: tmpDir })).content;
      if (readyLog.includes('ready')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(readyLog).toContain('ready');

    const running = JSON.parse((await processPoll.execute({ id: sessionId }, { cwd: tmpDir })).content) as {
      status: string;
    };
    expect(running.status).toBe('running');

    await processWrite.execute({ id: sessionId, data: 'ping\n' }, { cwd: tmpDir });

    let echoedLog = readyLog;
    for (let i = 0; i < 40; i++) {
      echoedLog = (await processLog.execute({ id: sessionId }, { cwd: tmpDir })).content;
      if (echoedLog.includes('echo:ping')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(echoedLog).toContain('echo:ping');

    await processKill.execute({ id: sessionId }, { cwd: tmpDir });

    let finalStatus = running.status;
    for (let i = 0; i < 40; i++) {
      finalStatus = JSON.parse((await processPoll.execute({ id: sessionId }, { cwd: tmpDir })).content).status as string;
      if (finalStatus === 'exited') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(finalStatus).toBe('exited');
  });
});

describe('Search tools', () => {
  it('grep finds pattern', async () => {
    const tools = createSearchTools(tmpDir);
    const grep = tools.find(t => t.definition.name === 'grep')!;
    const result = await grep.execute({ pattern: 'Hello', path: '.' }, { cwd: tmpDir });
    expect(result.content).toContain('Hello World');
  });

  it('find_files locates files', async () => {
    const tools = createSearchTools(tmpDir);
    const find = tools.find(t => t.definition.name === 'find_files')!;
    const result = await find.execute({ pattern: '*.ts', path: '.' }, { cwd: tmpDir });
    expect(result.content).toContain('code.ts');
  });

  it('blocks search paths outside the scoped workspace', async () => {
    const tools = createSearchTools(tmpDir);
    const grep = tools.find(t => t.definition.name === 'grep')!;
    const result = await grep.execute({ pattern: 'top-secret', path: `../${basename(siblingDir)}` }, { cwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes');
  });
});

describe('edit_file tool', () => {
  it('applies a single edit', async () => {
    const editTool = createEditFileTool(tmpDir);
    // Write a known file first
    await writeFile(join(tmpDir, 'edit-test.txt'), 'aaa\nbbb\nccc\n');
    const result = await editTool.execute(
      { path: 'edit-test.txt', edits: [{ oldText: 'bbb', newText: 'BBB' }] },
      { cwd: tmpDir },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Applied 1 edit(s)');
    const updated = await readFile(join(tmpDir, 'edit-test.txt'), 'utf-8');
    expect(updated).toBe('aaa\nBBB\nccc\n');
  });

  it('fails when oldText is not found', async () => {
    const editTool = createEditFileTool(tmpDir);
    await writeFile(join(tmpDir, 'edit-miss.txt'), 'hello world');
    const result = await editTool.execute(
      { path: 'edit-miss.txt', edits: [{ oldText: 'NOPE', newText: 'yes' }] },
      { cwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('fails when oldText is not unique', async () => {
    const editTool = createEditFileTool(tmpDir);
    await writeFile(join(tmpDir, 'edit-dup.txt'), 'abc\nabc\nabc');
    const result = await editTool.execute(
      { path: 'edit-dup.txt', edits: [{ oldText: 'abc', newText: 'xyz' }] },
      { cwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('multiple times');
  });

  it('applies multiple edits in sequence', async () => {
    const editTool = createEditFileTool(tmpDir);
    await writeFile(join(tmpDir, 'edit-multi.txt'), 'foo\nbar\nbaz');
    const result = await editTool.execute(
      {
        path: 'edit-multi.txt',
        edits: [
          { oldText: 'foo', newText: 'FOO' },
          { oldText: 'baz', newText: 'BAZ' },
        ],
      },
      { cwd: tmpDir },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Applied 2 edit(s)');
    const updated = await readFile(join(tmpDir, 'edit-multi.txt'), 'utf-8');
    expect(updated).toBe('FOO\nbar\nBAZ');
  });

  it('blocks edits outside the scoped workspace', async () => {
    const editTool = createEditFileTool(tmpDir);
    const result = await editTool.execute(
      {
        path: `../${basename(siblingDir)}/secret.txt`,
        edits: [{ oldText: 'top-secret', newText: 'leaked' }],
      },
      { cwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes');
  });
});

describe('web_fetch tool', () => {
  it('fetches and extracts HTML content', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><body><h1>Hello</h1><p>World</p></body></html>',
    });

    try {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'https://example.com' }, { cwd: '.' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('World');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns error on HTTP failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    try {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'https://example.com/nope' }, { cwd: '.' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('404');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('truncates content to maxChars', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'A'.repeat(1000),
    });

    try {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'https://example.com', maxChars: 100 }, { cwd: '.' });
      expect(result.content).toContain('Truncated');
      expect(result.content.length).toBeLessThan(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('web_search tool', () => {
  it('returns formatted search results via Tavily adapter', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Result 1', url: 'https://example.com/1', content: 'Snippet one' },
          { title: 'Result 2', url: 'https://example.com/2', content: 'Snippet two' },
        ],
      }),
    });

    try {
      const tool = createWebSearchTool({ provider: 'tavily', apiKey: 'test-key' });
      const result = await tool.execute({ query: 'test query' }, { cwd: '.' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Result 1');
      expect(result.content).toContain('https://example.com/1');
      expect(result.content).toContain('Snippet one');
      expect(result.content).toContain('Result 2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns formatted search results via Brave adapter', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: { results: [{ title: 'Brave Result', url: 'https://brave.com', description: 'Brave snippet' }] },
      }),
    });

    try {
      const tool = createWebSearchTool({ provider: 'brave', apiKey: 'test-key' });
      const result = await tool.execute({ query: 'test' }, { cwd: '.' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Brave Result');
      expect(result.content).toContain('Brave snippet');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns formatted search results via SerpAPI adapter', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        organic_results: [{ title: 'Serp Result', link: 'https://serp.com', snippet: 'Serp snippet' }],
      }),
    });

    try {
      const tool = createWebSearchTool({ provider: 'serpapi', apiKey: 'test-key' });
      const result = await tool.execute({ query: 'test' }, { cwd: '.' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Serp Result');
      expect(result.content).toContain('Serp snippet');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles API error gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    try {
      const tool = createWebSearchTool({ provider: 'tavily', apiKey: 'bad-key' });
      const result = await tool.execute({ query: 'test' }, { cwd: '.' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('browser tool', () => {
  it('creates tool with correct definition', async () => {
    const { createBrowserTool } = await import('../browser.js');
    const tool = createBrowserTool();
    expect(tool.definition.name).toBe('browser');
    expect(tool.definition.inputSchema.required).toContain('action');
  });

  it('returns error when playwright is not installed', async () => {
    // In CI / test env without playwright browsers, the tool should error gracefully
    const { createBrowserTool } = await import('../browser.js');
    const tool = createBrowserTool();
    const result = await tool.execute({ action: 'navigate', url: 'https://example.com' }, { cwd: '.' });
    // Either playwright isn't installed or browsers aren't available — both produce isError
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error');
  });
});

describe('createAllTools', () => {
  it('returns file, shell/process, and search tools together', () => {
    const tools = createAllTools(tmpDir);
    expect(tools).toHaveLength(12);
    const names = tools.map(t => t.definition.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('edit_file');
    expect(names).toContain('shell');
    expect(names).toContain('process_list');
    expect(names).toContain('process_poll');
    expect(names).toContain('process_log');
    expect(names).toContain('process_write');
    expect(names).toContain('process_kill');
    expect(names).toContain('grep');
    expect(names).toContain('find_files');
  });
});

describe('ProviderRegistry', () => {
  // Import here to test alongside tools
  it('imported from core and works', async () => {
    const { ProviderRegistry } = await import('@berry-agent/core');
    const reg = new ProviderRegistry();
    reg.register('test', { type: 'openai', apiKey: 'k', models: ['gpt-4o', 'gpt-4o-mini'] });
    reg.setDefault('gpt-4o');

    expect(reg.listModels()).toHaveLength(2);
    expect(reg.getDefault()).toBe('gpt-4o');

    const resolved = reg.resolve('gpt-4o-mini');
    expect(resolved).not.toBeNull();
    expect(resolved!.providerName).toBe('test');

    const config = reg.toProviderConfig('gpt-4o');
    expect(config.type).toBe('openai');
    expect(config.model).toBe('gpt-4o');
    expect(config.apiKey).toBe('k');
  });
});
