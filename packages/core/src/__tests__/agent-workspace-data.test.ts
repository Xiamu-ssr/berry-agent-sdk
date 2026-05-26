import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Agent } from '../agent.js';
import type { Provider, ProviderResponse } from '../index.js';
import { AgentHome } from '../agent-home.js';
import { PROJECT_CONTEXT_FILE } from '../workspace/file-project.js';

class NoopProvider implements Provider {
  readonly type = 'anthropic' as const;
  async chat(): Promise<ProviderResponse> {
    return {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

describe('Agent workspace data APIs', () => {
  let tmp: string;
  let home: AgentHome;
  let project: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'berry-agent-data-'));
    home = new AgentHome(join(tmp, 'agent'));
    project = join(tmp, 'project');
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads and writes SDK-owned personal memory', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new NoopProvider(),
      home,
    });

    expect(await agent.readMemory()).toEqual({ path: home.memoryPath, content: '' });

    await agent.writeMemory('remember this\n');

    expect(await agent.readMemory()).toEqual({ path: home.memoryPath, content: 'remember this\n' });
  });

  it('reads project knowledge through the SDK project context', async () => {
    await writeFile(join(project, PROJECT_CONTEXT_FILE), '# Project\n', 'utf-8');
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new NoopProvider(),
      home,
      project,
    });

    expect(await agent.readProjectKnowledge()).toEqual({
      project,
      files: [{ path: PROJECT_CONTEXT_FILE, content: '# Project\n' }],
    });
  });

  it('reads and writes SDK-owned workspace instructions', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new NoopProvider(),
      home,
    });

    expect(await agent.readInstructions()).toEqual({ path: home.agentMdPath, content: '' });

    const written = await agent.writeInstructions('# Agent instructions\n');
    expect(written).toEqual({
      path: home.agentMdPath,
      bytes: Buffer.byteLength('# Agent instructions\n', 'utf-8'),
    });
    expect(await agent.readInstructions()).toEqual({
      path: home.agentMdPath,
      content: '# Agent instructions\n',
    });
  });

  it('writes project knowledge through the SDK project context', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new NoopProvider(),
      home,
      project,
    });

    const written = await agent.writeProjectKnowledge('# Shared project rules\n');
    expect(written).toEqual({
      project,
      path: PROJECT_CONTEXT_FILE,
      bytes: Buffer.byteLength('# Shared project rules\n', 'utf-8'),
    });
    expect(await agent.readProjectKnowledge()).toEqual({
      project,
      files: [{ path: PROJECT_CONTEXT_FILE, content: '# Shared project rules\n' }],
    });
  });
});
