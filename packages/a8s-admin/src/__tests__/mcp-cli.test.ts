// ============================================================
// @berry-agent/a8s-admin — berry-mcp CLI tests
// ============================================================
// MCP as a CLI (second-class). main() is dependency-injected (client factory
// + output writers + env) so we exercise the full command surface without
// env, network, or process side-effects.

import { describe, expect, it } from 'vitest';
import { main, type McpCliDeps } from '../mcp-cli.js';

function makeStubClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return Promise.resolve(typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : fn);
  };
  const client = {
    listMachines: rec('listMachines'),
    machineMcpManifest: rec('machineMcpManifest'),
    machineMcpInvoke: rec('machineMcpInvoke'),
  };
  return { client, calls };
}

interface Captured { out: string; err: string; code: number }
async function run(
  argv: string[],
  client: ReturnType<typeof makeStubClient>['client'],
  env: Record<string, string> = { BERRY_A8S_ADMIN_TOKEN: 't' },
): Promise<Captured> {
  let out = ''; let err = '';
  const deps: McpCliDeps = {
    makeClient: () => client as never,
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
    env,
  };
  const code = await main(argv, deps);
  return { out, err, code };
}

describe('berry-mcp main()', () => {
  it('usage: exit 2 no args, 0 with --help', async () => {
    const { client } = makeStubClient();
    expect((await run([], client)).code).toBe(2);
    expect((await run(['--help'], client)).code).toBe(0);
    expect((await run(['--help'], client)).out).toContain('berry-mcp');
  });

  it('requires a token', async () => {
    const { client } = makeStubClient();
    const r = await run(['list'], client, {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/token/);
  });

  it('list shows only machines that proxy MCP servers', async () => {
    const { client, calls } = makeStubClient({
      listMachines: {
        machines: [
          { machineId: 'mac-1', state: 'active', callbackUrl: '', mcpServers: ['playwright'], mcpToolCount: 3, registeredAt: 0, heartbeatAt: 0, heartbeatExpiresAt: 0 },
          { machineId: 'bare', state: 'active', callbackUrl: '', mcpServers: [], mcpToolCount: 0, registeredAt: 0, heartbeatAt: 0, heartbeatExpiresAt: 0 },
        ],
      },
    });
    const r = await run(['list'], client);
    expect(r.code).toBe(0);
    expect(r.out).toContain('mac-1');
    expect(r.out).toContain('playwright');
    expect(r.out).not.toContain('bare'); // no MCP → hidden
    expect(calls.map((c) => c.method)).toEqual(['listMachines']);
  });

  it('tools lists a machine MCP manifest, filterable by server', async () => {
    const { client, calls } = makeStubClient({
      machineMcpManifest: {
        tools: [
          { server: 'playwright', name: 'browser_navigate', description: 'go to url' },
          { server: 'db', name: 'query' },
        ],
      },
    });
    const all = await run(['tools', 'mac-1'], client);
    expect(all.code).toBe(0);
    expect(all.out).toContain('browser_navigate');
    expect(all.out).toContain('query');
    expect(calls[0].args[0]).toBe('mac-1');

    const filtered = await run(['tools', 'mac-1', '--server', 'playwright'], client);
    expect(filtered.out).toContain('browser_navigate');
    expect(filtered.out).not.toContain('\tquery');
  });

  it('call invokes an MCP tool with parsed JSON input', async () => {
    const { client, calls } = makeStubClient({
      machineMcpInvoke: { content: 'navigated', isError: false },
    });
    const r = await run(
      ['call', 'mac-1', 'playwright', 'browser_navigate', '--input', '{"url":"https://example.com"}'],
      client,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('navigated');
    expect(calls[0].args[0]).toBe('mac-1');
    expect(calls[0].args[1]).toEqual({ server: 'playwright', name: 'browser_navigate', input: { url: 'https://example.com' } });
  });

  it('call defaults input to {} and propagates isError as exit 1', async () => {
    const { client, calls } = makeStubClient({
      machineMcpInvoke: { content: 'boom', isError: true },
    });
    const r = await run(['call', 'mac-1', 'db', 'query'], client);
    expect(r.code).toBe(1);
    expect((calls[0].args[1] as { input: unknown }).input).toEqual({});
  });

  it('call rejects malformed --input JSON', async () => {
    const { client } = makeStubClient();
    const r = await run(['call', 'mac-1', 'db', 'query', '--input', 'not-json'], client);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not valid JSON/);
  });

  it('call rejects a non-object --input', async () => {
    const { client } = makeStubClient();
    const r = await run(['call', 'mac-1', 'db', 'query', '--input', '[1,2]'], client);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/must be a JSON object/);
  });

  it('unknown command exits 2', async () => {
    const { client } = makeStubClient();
    expect((await run(['frobnicate'], client)).code).toBe(2);
  });
});
