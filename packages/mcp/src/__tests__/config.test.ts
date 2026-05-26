import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PLAYWRIGHT_MCP_BIN,
  DEFAULT_PLAYWRIGHT_MCP_PACKAGE,
  DEFAULT_PLAYWRIGHT_MCP_TEMPLATE,
  ensureDefaultPlaywrightMCPConfig,
  ensureMCPConfigFile,
  loadMergedMCPConfig,
  normalizeDefaultMCPServerConfig,
  normalizeMCPConfigRecord,
  normalizeMCPServerConfig,
  type MCPServerConfig,
} from '../index.js';

function server(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    transport: { type: 'stdio', command: 'npx', args: ['@playwright/mcp', '--headless'] },
    shared: false,
    prefix: undefined,
    enabled: true,
    layer: 'agent',
    ...overrides,
  };
}

describe('MCP config normalization', () => {
  it('rewrites selected npx packages to a host-resolved local node entrypoint', () => {
    const resolvePackageBin = vi.fn(() => '/host/node_modules/@playwright/mcp/cli.js');

    const normalized = normalizeDefaultMCPServerConfig(server(), {
      nodePath: '/usr/local/bin/node',
      resolvePackageBin,
    });

    expect(resolvePackageBin).toHaveBeenCalledWith(DEFAULT_PLAYWRIGHT_MCP_PACKAGE, DEFAULT_PLAYWRIGHT_MCP_BIN);
    expect(normalized.transport).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/node',
      args: ['/host/node_modules/@playwright/mcp/cli.js', '--headless'],
    });
  });

  it('supports versioned npx package args', () => {
    const normalized = normalizeMCPServerConfig(
      server({ transport: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.73', '--headless'] } }),
      {
        nodePath: '/node',
        resolvePackageBin: () => '/pkg/cli.js',
        npxPackageRewrites: [{
          packageName: '@playwright/mcp',
          binRelativePath: 'cli.js',
        }],
      },
    );

    expect(normalized.transport).toEqual({
      type: 'stdio',
      command: '/node',
      args: ['/pkg/cli.js', '--headless'],
    });
  });

  it('leaves other transports and unresolved packages unchanged', () => {
    const http = server({ transport: { type: 'http', url: 'https://example.com/mcp' } });
    expect(normalizeDefaultMCPServerConfig(http, { resolvePackageBin: () => '/unused' })).toBe(http);

    const unresolved = server();
    expect(normalizeDefaultMCPServerConfig(unresolved, { resolvePackageBin: () => null })).toBe(unresolved);
  });

  it('normalizes records without mutating unrelated entries', () => {
    const record = {
      playwright: server(),
      docs: server({ transport: { type: 'stdio', command: 'docs-mcp' } }),
    };

    const normalized = normalizeMCPConfigRecord(record, {
      nodePath: '/node',
      resolvePackageBin: () => '/pkg/cli.js',
      npxPackageRewrites: [{ packageName: '@playwright/mcp', binRelativePath: 'cli.js' }],
    });

    expect(normalized.playwright.transport).toEqual({
      type: 'stdio',
      command: '/node',
      args: ['/pkg/cli.js', '--headless'],
    });
    expect(normalized.docs).toBe(record.docs);
  });

  it('ensures default MCP config files without overwriting existing content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-mcp-config-'));
    try {
      const path = join(dir, 'agent', '.mcp.json');
      expect(ensureDefaultPlaywrightMCPConfig(path)).toBe(true);
      expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual(DEFAULT_PLAYWRIGHT_MCP_TEMPLATE);

      expect(ensureMCPConfigFile(path, { template: { mcpServers: { custom: {} } } })).toBe(false);
      expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual(DEFAULT_PLAYWRIGHT_MCP_TEMPLATE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads only schema-valid MCP servers from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-mcp-config-'));
    const path = join(dir, '.mcp.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(path, JSON.stringify({
        mcpServers: {
          good: {
            command: 'node',
            args: ['server.js'],
            env: { TOKEN: 'secret' },
            shared: true,
          },
          badArgs: {
            command: 'node',
            args: [123],
          },
          badHeaders: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 123 },
          },
        },
      }));

      const loaded = loadMergedMCPConfig({ layers: [{ filePath: path, label: 'agent' }] });

      expect(Object.keys(loaded)).toEqual(['good']);
      expect(loaded.good.transport).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'secret' },
      });
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores malformed MCP root shapes instead of inventing partial config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-mcp-config-'));
    const path = join(dir, '.mcp.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(path, JSON.stringify({ mcpServers: [] }));

      const loaded = loadMergedMCPConfig({ layers: [{ filePath: path, label: 'agent' }] });

      expect(loaded).toEqual({});
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"mcpServers" must be a JSON object'));
    } finally {
      errorSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
