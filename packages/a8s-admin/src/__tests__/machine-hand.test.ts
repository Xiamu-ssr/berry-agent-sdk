// ============================================================
// @berry-agent/a8s-admin — machine Hand unit tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { A8sOperatorClient } from '../operator-client.js';
import { buildMachineTools, createMachineHand } from '../machine-hand.js';

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('machine Hand', () => {
  it('exposes one exec tool whose name embeds the (sanitized) machineId', () => {
    const client = new A8sOperatorClient({ a8sUrl: 'http://test', adminToken: 'x' });
    const hand = createMachineHand({ client, machineId: 'mac.office-1', platform: 'macos' });
    const names = hand.capabilities().map((c) => c.definition.name);
    expect(names).toEqual(['machine_mac_office-1_exec']);
  });

  it('exec tool routes through the a8s broker and returns output', async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = init?.body;
      return jsonResponse(200, { output: 'hello from machine', isError: false });
    });
    const client = new A8sOperatorClient({ a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl });
    const [tool] = buildMachineTools({ client, machineId: 'mac-1' });
    const result = await tool.execute({ command: 'echo hi' }, { cwd: '/tmp' });
    expect(seenUrl).toBe('http://a8s/v1/machines/mac-1/exec');
    expect(JSON.parse(String(seenBody)).command).toBe('echo hi');
    expect(result.content).toContain('hello from machine');
    expect(result.isError).toBeUndefined();
  });

  it('surfaces broker errors as isError', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(404, { error: { code: 'unknown_machine', message: 'gone' } }));
    const client = new A8sOperatorClient({ a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl });
    const [tool] = buildMachineTools({ client, machineId: 'ghost' });
    const result = await tool.execute({ command: 'echo hi' }, { cwd: '/tmp' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/HTTP 404/);
  });

  it('requires a non-empty command', async () => {
    const client = new A8sOperatorClient({ a8sUrl: 'http://a8s', adminToken: 'tok' });
    const [tool] = buildMachineTools({ client, machineId: 'mac-1' });
    const result = await tool.execute({ command: '   ' }, { cwd: '/tmp' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/required/);
  });

  it('projects MCP manifest tools with machine + server namespaced names (M6)', () => {
    const client = new A8sOperatorClient({ a8sUrl: 'http://a8s', adminToken: 'tok' });
    const tools = buildMachineTools({
      client,
      machineId: 'mac.office-1',
      mcpTools: [
        { server: 'playwright', name: 'browser_navigate', description: 'go to url' },
        { server: 'my-corp', name: 'lookup.employee' },
      ],
    });
    const names = tools.map((t) => t.definition.name);
    // exec tool + one per MCP tool, all namespaced by machine then server.
    expect(names).toEqual([
      'machine_mac_office-1_exec',
      'machine_mac_office-1__playwright_browser_navigate',
      'machine_mac_office-1__my-corp_lookup_employee',
    ]);
  });

  it('MCP tool routes through the a8s mcp/invoke broker with the upstream (server,name)', async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = init?.body;
      return jsonResponse(200, { content: 'navigated', isError: false });
    });
    const client = new A8sOperatorClient({ a8sUrl: 'http://a8s', adminToken: 'tok', fetch: fetchImpl });
    const tools = buildMachineTools({
      client,
      machineId: 'mac-1',
      mcpTools: [{ server: 'playwright', name: 'browser_navigate' }],
    });
    const mcpTool = tools.find((t) => t.definition.name === 'machine_mac-1__playwright_browser_navigate')!;
    const result = await mcpTool.execute({ url: 'https://example.com' }, { cwd: '/' });
    expect(seenUrl).toBe('http://a8s/v1/machines/mac-1/mcp/invoke');
    const body = JSON.parse(String(seenBody));
    // Dispatch key is the *upstream* server + unprefixed tool name; the
    // model-facing prefix never leaks back to the MCP server.
    expect(body.server).toBe('playwright');
    expect(body.name).toBe('browser_navigate');
    expect(body.input).toEqual({ url: 'https://example.com' });
    expect(result.content).toContain('navigated');
  });
});
