import { describe, expect, it } from 'vitest';
import { Agent } from '../agent.js';
import {
  HandRegistry,
  ManagedAgentRuntime,
  ToolGroup,
  createHandToolRegistrations,
  createToolRegistrationHand,
  evaluateHandCapabilityPolicy,
  handCapabilityAuditEventSchema,
  handCapabilityPolicySchema,
  type HandCapabilityAuditEvent,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ToolRegistration,
} from '../index.js';
import {
  CONFIGURED_TOOLS_HAND_ID,
  RUNTIME_TOOL_HAND_ID_PREFIX,
} from '../agent-helpers/capabilities.js';
import { tmpHome } from './helpers.js';

class SequenceProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No fake response left');
    return structuredClone(response);
  }
}

function usage() {
  return { inputTokens: 10, outputTokens: 5 };
}

function tool(name: string, content = name): ToolRegistration {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    },
    execute: async (input, context) => ({
      content: JSON.stringify({
        content,
        input,
        handId: (context as typeof context & { handId?: string }).handId,
      }),
    }),
  };
}

describe('hands', () => {
  it('wraps existing tools as a hand and exposes normal tool registrations', async () => {
    const hand = createToolRegistrationHand({
      id: 'local-workspace',
      kind: 'local',
      tools: [tool('read_file', 'ok')],
    });

    const registrations = createHandToolRegistrations([hand]);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.definition.name).toBe('read_file');
    expect(registrations[0]!.source).toEqual({
      kind: 'hand',
      hand: 'local-workspace',
      handKind: 'local',
    });

    const result = await registrations[0]!.execute({ path: 'README.md' }, { cwd: '/tmp' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      content: 'ok',
      input: { path: 'README.md' },
      handId: 'local-workspace',
    });
  });

  it('fails fast on duplicate model-visible tool names', () => {
    const left = createToolRegistrationHand({ id: 'left', tools: [tool('shell')] });
    const right = createToolRegistrationHand({ id: 'right', tools: [tool('shell')] });

    expect(() => createHandToolRegistrations([left, right])).toThrow(/Duplicate hand tool name/);
    expect(createHandToolRegistrations([left, right], { onCollision: 'skip' })).toHaveLength(1);
  });

  it('preserves explicit upstream provenance for wrapped capabilities', () => {
    const hand = createToolRegistrationHand({
      id: 'mcp:github',
      kind: 'mcp',
      tools: [{
        ...tool('github_create_pr'),
        source: { kind: 'mcp', server: 'github' },
      }],
    });

    expect(createHandToolRegistrations([hand])[0]!.source).toEqual({
      kind: 'mcp',
      server: 'github',
    });
  });

  it('evaluates capability policy by hand, tool, group, and MCP server', () => {
    expect(evaluateHandCapabilityPolicy({
      allowMcpServers: ['github'],
    }, {
      handId: 'mcp:docs',
      handKind: 'mcp',
      capabilityId: 'search',
      toolName: 'docs_search',
      toolGroup: ToolGroup.Other,
      source: { kind: 'mcp', server: 'docs' },
    })).toEqual({
      action: 'deny',
      reason: 'MCP server "docs" is not allowed',
    });

    expect(evaluateHandCapabilityPolicy({
      denyToolGroups: [ToolGroup.Shell],
    }, {
      handId: 'local',
      handKind: 'shell',
      capabilityId: 'shell',
      toolName: 'shell',
      toolGroup: ToolGroup.Shell,
      source: { kind: 'hand', hand: 'local', handKind: 'shell' },
    })).toEqual({
      action: 'deny',
      reason: 'tool group "shell" is denied',
    });
  });

  it('filters capabilities through hand policy and emits audit events', async () => {
    const events: HandCapabilityAuditEvent[] = [];
    const allowed = createToolRegistrationHand({
      id: 'mcp:github',
      kind: 'mcp',
      tools: [{
        ...tool('github_search', 'ok'),
        definition: {
          ...tool('github_search').definition,
          group: ToolGroup.Web,
        },
        source: { kind: 'mcp', server: 'github' },
      }],
    });
    const denied = createToolRegistrationHand({
      id: 'mcp:docs',
      kind: 'mcp',
      tools: [{
        ...tool('docs_search'),
        source: { kind: 'mcp', server: 'docs' },
      }],
    });

    const registrations = createHandToolRegistrations([allowed, denied], {
      policy: { allowMcpServers: ['github'] },
      auditSink: (event) => { events.push(event); },
      now: () => 123,
    });

    expect(registrations.map((registration) => registration.definition.name)).toEqual(['github_search']);
    await expect(registrations[0]!.execute({}, { cwd: '/tmp' })).resolves.toMatchObject({
      content: expect.stringContaining('ok'),
    });
    expect(events.map((event) => [event.phase, event.action, event.toolName, event.reason])).toEqual([
      ['expose', 'allow', 'github_search', undefined],
      ['expose', 'deny', 'docs_search', 'MCP server "docs" is not allowed'],
      ['execute', 'allow', 'github_search', undefined],
    ]);
    expect(handCapabilityAuditEventSchema.parse(events[0])).toMatchObject({
      timestamp: 123,
      toolGroup: ToolGroup.Web,
    });
    expect(handCapabilityPolicySchema.parse({ denyHands: ['x'] })).toEqual({ denyHands: ['x'] });
  });

  it('tracks registered hand status', async () => {
    const registry = new HandRegistry();
    registry.register(createToolRegistrationHand({
      id: 'browser',
      kind: 'browser',
      displayName: 'Browser',
      tools: [tool('browser_navigate')],
    }));

    expect(registry.statuses()).toEqual([{
      id: 'browser',
      kind: 'browser',
      displayName: 'Browser',
      state: 'ready',
    }]);
    expect(registry.toolRegistrations()[0]!.source?.hand).toBe('browser');

    await registry.disposeAll();
    expect(registry.list()).toEqual([]);
  });

  it('clears every registered hand even when one disposer throws', async () => {
    const registry = new HandRegistry();
    let disposed = 0;
    registry.register(createToolRegistrationHand({
      id: 'bad',
      kind: 'system',
      tools: [{
        ...tool('bad_tool'),
        dispose: () => {
          throw new Error('dispose failed');
        },
      }],
    }));
    registry.register(createToolRegistrationHand({
      id: 'good',
      kind: 'system',
      tools: [{
        ...tool('good_tool'),
        dispose: () => {
          disposed += 1;
        },
      }],
    }));

    await expect(registry.disposeAll()).rejects.toThrow(/dispose failed/);
    expect(disposed).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  it('lets Agent own hand registration and execution', async () => {
    const provider = new SequenceProvider([
      {
        content: [{
          type: 'tool_use',
          id: 'tu_1',
          name: 'read_file',
          input: { path: 'README.md' },
        }],
        stopReason: 'tool_use',
        usage: usage(),
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: usage(),
      },
    ]);
    const hand = createToolRegistrationHand({
      id: 'local-workspace',
      kind: 'local',
      tools: [tool('read_file', 'ok')],
    });
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: provider,
      home: tmpHome('berry-hand-agent-'),
      hands: [hand],
    });

    const result = await agent.send('read it');

    expect(result.text).toBe('done');
    expect(provider.requests[0]!.tools?.map((definition) => definition.name)).toContain('read_file');
    const session = await agent.getSession(result.sessionId);
    const toolResult = session!.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_result');
    expect(toolResult?.content).toContain('"handId":"local-workspace"');
  });

  it('removes tools when an Agent hand is removed', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new SequenceProvider([]),
      home: tmpHome('berry-hand-remove-'),
    });

    agent.addHand(createToolRegistrationHand({
      id: 'browser',
      kind: 'browser',
      tools: [tool('browser_navigate')],
    }));
    expect(agent.getTools().map((definition) => definition.name)).toContain('browser_navigate');

    await expect(agent.removeHand('browser')).resolves.toBe(true);
    expect(agent.getTools().map((definition) => definition.name)).not.toContain('browser_navigate');
  });

  it('lets ManagedAgentRuntime remove mounted hands without exposing Agent', async () => {
    const runtime = ManagedAgentRuntime.create({
      config: {
        provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
        providerInstance: new SequenceProvider([]),
        home: tmpHome('berry-runtime-hand-remove-'),
      },
    });

    runtime.addHand(createToolRegistrationHand({
      id: 'mcp:docs',
      kind: 'mcp',
      tools: [tool('docs_search')],
    }));

    expect(runtime.hasHand('mcp:docs')).toBe(true);
    await expect(runtime.removeHand('mcp:docs')).resolves.toBe(true);
    expect(runtime.hasHand('mcp:docs')).toBe(false);
  });

  it('wraps constructor tools as an SDK-owned configured-tools hand', () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new SequenceProvider([]),
      home: tmpHome('berry-configured-tools-'),
      tools: [tool('echo')],
    });

    expect(agent.hasHand(CONFIGURED_TOOLS_HAND_ID)).toBe(true);
    expect(agent.getTools().map((definition) => definition.name)).toContain('echo');
  });

  it('applies Agent hand policy to constructor hands, direct tools, and runtime tools', async () => {
    const events: HandCapabilityAuditEvent[] = [];
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new SequenceProvider([]),
      home: tmpHome('berry-hand-policy-'),
      handPolicy: {
        denyHands: [CONFIGURED_TOOLS_HAND_ID],
        denyTools: ['browser_navigate'],
      },
      handAuditSink: (event) => { events.push(event); },
      tools: [tool('configured_echo')],
      hands: [createToolRegistrationHand({
        id: 'browser',
        kind: 'browser',
        tools: [tool('browser_navigate')],
      })],
    });

    expect(agent.hasHand(CONFIGURED_TOOLS_HAND_ID)).toBe(true);
    expect(agent.getTools().map((definition) => definition.name)).not.toContain('configured_echo');
    expect(agent.getTools().map((definition) => definition.name)).not.toContain('browser_navigate');

    agent.addTool(tool('runtime_echo'));
    expect(agent.getTools().map((definition) => definition.name)).toContain('runtime_echo');
    await agent.removeTool('runtime_echo');
    expect(events.some((event) => event.action === 'deny' && event.toolName === 'configured_echo')).toBe(true);
    expect(events.some((event) => event.action === 'deny' && event.toolName === 'browser_navigate')).toBe(true);
  });

  it('wraps runtime addTool as a one-tool hand and removes it cleanly', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new SequenceProvider([]),
      home: tmpHome('berry-runtime-tool-'),
    });

    agent.addTool(tool('echo'));

    expect(agent.hasHand(`${RUNTIME_TOOL_HAND_ID_PREFIX}echo`)).toBe(true);
    expect(agent.getTools().map((definition) => definition.name)).toContain('echo');
    await expect(agent.removeTool('echo')).resolves.toBe(true);
    expect(agent.hasHand(`${RUNTIME_TOOL_HAND_ID_PREFIX}echo`)).toBe(false);
    expect(agent.getTools().map((definition) => definition.name)).not.toContain('echo');
  });

  it('disposes runtime-added tool resources when removeTool removes the backing hand', async () => {
    const agent = new Agent({
      provider: { type: 'anthropic', apiKey: 'test', model: 'fake' },
      providerInstance: new SequenceProvider([]),
      home: tmpHome('berry-runtime-tool-dispose-'),
    });
    let disposed = 0;

    agent.addTool({
      ...tool('echo'),
      dispose: () => {
        disposed += 1;
      },
    });

    await expect(agent.removeTool('echo')).resolves.toBe(true);
    expect(disposed).toBe(1);
  });
});
