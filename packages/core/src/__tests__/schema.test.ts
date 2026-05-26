import { describe, expect, it } from 'vitest';
import { zAgentHomeSnapshot, zContentBlock, zProjectSharedPaths, zUserContentBlock } from '../schema.js';
import { AgentHome } from '../agent-home.js';
import { projectSharedPaths } from '../workspace/project-layout.js';

describe('content block schemas', () => {
  it('accepts user-authored multimodal blocks', () => {
    expect(zUserContentBlock.parse({ type: 'text', text: 'look here' })).toEqual({
      type: 'text',
      text: 'look here',
    });

    const annotation = zUserContentBlock.parse({
      type: 'annotation',
      body: 'The title wraps awkwardly.',
      source: { url: 'https://example.test/dashboard', title: 'Dashboard' },
      rect: { x: 12, y: 24, width: 200, height: 80 },
      viewport: { width: 1280, height: 720 },
      image: { data: 'iVBORw0KGgo=', mediaType: 'image/png', width: 200, height: 80 },
    });
    expect(annotation.type).toBe('annotation');
  });

  it('keeps assistant/tool blocks out of user-authored input', () => {
    expect(() => zUserContentBlock.parse({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'shell',
      input: {},
    })).toThrow();
  });

  it('accepts the full provider-context content union', () => {
    const parsed = zContentBlock.parse({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      content: 'ok',
      isError: false,
    });
    expect(parsed.type).toBe('tool_result');
  });

  it('publishes the SDK project layout schema for host facts', () => {
    expect(zProjectSharedPaths.parse(projectSharedPaths('/tmp/project'))).toMatchObject({
      root: '/tmp/project',
      contextPath: '/tmp/project/AGENTS.md',
      berryDir: '/tmp/project/.berry',
    });
  });

  it('publishes the SDK agent home schema for host facts', () => {
    expect(zAgentHomeSnapshot.parse(new AgentHome('/tmp/agent').toSnapshot())).toMatchObject({
      root: '/tmp/agent',
      agentMdPath: '/tmp/agent/AGENTS.md',
      memoryPath: '/tmp/agent/MEMORY.md',
    });
  });
});
