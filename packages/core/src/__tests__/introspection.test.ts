// ============================================================
// Introspection — getMCP() and snapshot().mcp
// ============================================================

import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';
import type {
  Provider,
  ProviderConfig,
  ProviderResponse,
  ToolRegistration,
} from '../types.js';
import { tmpHome } from './helpers.js';

class FakeProvider implements Provider {
  readonly type = 'anthropic' as const;
  async chat(): Promise<ProviderResponse> {
    return {
      content: [{ type: 'text', text: 'noop' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'fake',
    };
  }
}

const providerConfig: ProviderConfig = { type: 'anthropic', apiKey: 'x', model: 'fake' };

function mcpTool(server: string, upstream: string): ToolRegistration {
  return {
    definition: {
      name: `mcp__${server}__${upstream}`,
      description: `${server}/${upstream}`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'ok' }),
    source: { kind: 'mcp', server },
  };
}

function builtinTool(name: string): ToolRegistration {
  return {
    definition: { name, description: name, inputSchema: { type: 'object', properties: {} } },
    execute: async () => ({ content: 'ok' }),
  };
}

describe('getMCP', () => {
  it('returns empty list when no MCP tools are registered', () => {
    const agent = new Agent({
      home: tmpHome(),
      provider: providerConfig,
      providerInstance: new FakeProvider(),
      systemPrompt: 'x',
      tools: [builtinTool('echo')],
    });
    expect(agent.getMCP()).toEqual([]);
  });

  it('groups MCP tools by upstream server, sorted by server name', () => {
    const agent = new Agent({
      home: tmpHome(),
      provider: providerConfig,
      providerInstance: new FakeProvider(),
      systemPrompt: 'x',
      tools: [
        builtinTool('echo'),
        mcpTool('github', 'create_pr'),
        mcpTool('playwright', 'click'),
        mcpTool('github', 'list_issues'),
      ],
    });

    const mcp = agent.getMCP();
    expect(mcp.map((s) => s.server)).toEqual(['github', 'playwright']);

    const github = mcp.find((s) => s.server === 'github')!;
    expect(github.tools.map((t) => t.name).sort()).toEqual([
      'mcp__github__create_pr',
      'mcp__github__list_issues',
    ]);

    const playwright = mcp.find((s) => s.server === 'playwright')!;
    expect(playwright.tools.map((t) => t.name)).toEqual(['mcp__playwright__click']);
  });

  it('ignores tools that lack the mcp source tag (kind=builtin, or undefined)', () => {
    const agent = new Agent({
      home: tmpHome(),
      provider: providerConfig,
      providerInstance: new FakeProvider(),
      systemPrompt: 'x',
      tools: [builtinTool('echo'), mcpTool('srv', 't')],
    });
    expect(agent.getMCP().length).toBe(1);
    expect(agent.getMCP()[0]!.server).toBe('srv');
  });

  it('snapshot().mcp mirrors getMCP()', () => {
    const agent = new Agent({
      home: tmpHome(),
      provider: providerConfig,
      providerInstance: new FakeProvider(),
      systemPrompt: 'x',
      tools: [mcpTool('alpha', 'a'), mcpTool('beta', 'b')],
    });
    const snap = agent.snapshot();
    expect(snap.mcp).toEqual(agent.getMCP());
    expect(snap.mcp.map((s) => s.server)).toEqual(['alpha', 'beta']);
  });
});
