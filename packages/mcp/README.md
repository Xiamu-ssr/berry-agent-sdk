# @berry-agent/mcp

MCP (Model Context Protocol) client adapter for [Berry Agent SDK](https://github.com/Xiamu-ssr/berry-agent-sdk).

Connect any MCP server (stdio or HTTP) and use its tools with Berry agents.

Berry supports **two MCP integration modes**:

1. **Atomic / first-class** — convert each MCP tool into a Berry tool with `createMCPTools()`
2. **Central / second-class** — register many MCP servers in an `MCPToolCenter`, then expose only `list_mcp_tools` + `use_mcp` to the agent

## Install

```bash
npm install @berry-agent/mcp @berry-agent/core
```

## Quick Start

### Mode A — Atomic / first-class MCP tools

```typescript
import { Agent } from '@berry-agent/core';
import { MCPClient, createMCPTools } from '@berry-agent/mcp';

const mcp = new MCPClient({
  name: 'filesystem',
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  },
});
await mcp.connect();

const tools = await createMCPTools(mcp, { prefix: 'fs_' });

const agent = new Agent({
  provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
  systemPrompt: 'You have filesystem tools available.',
  tools,
});
```

### Mode B — Central / second-class MCP tools (recommended for many MCP servers)

```typescript
import { Agent } from '@berry-agent/core';
import { MCPClient, MCPToolCenter, createMCPCenterTools } from '@berry-agent/mcp';

const fs = new MCPClient({ name: 'filesystem', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } });
const github = new MCPClient({ name: 'github', transport: { type: 'http', url: 'https://mcp.example.com/github' } });

await Promise.all([fs.connect(), github.connect()]);

const center = new MCPToolCenter();
center.register(fs);
center.register(github);

const agent = new Agent({
  provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
  systemPrompt: 'External MCP servers are available through list_mcp_tools and use_mcp.',
  tools: createMCPCenterTools(center),
});
```

This keeps external MCP tools **out of the first-class tool list** by default, which is better when you have many MCP servers and want to avoid tool-list explosion in prompt context.

## HTTP Transport

```typescript
const mcp = new MCPClient({
  name: 'remote-server',
  transport: {
    type: 'http',
    url: 'https://mcp.example.com/api',
    headers: { Authorization: 'Bearer token' },
  },
});
```

## Tool Filtering

```typescript
// Only include specific tools
const tools = await createMCPTools(mcp, {
  include: ['read_file', 'write_file'],
});

// Exclude dangerous tools
const tools = await createMCPTools(mcp, {
  exclude: ['delete_file', 'execute_command'],
});
```

## Multiple MCP Servers

If you want **every MCP tool to be first-class**, you can still do this:

```typescript
const fsMcp = new MCPClient({ name: 'fs', transport: { ... } });
const searchMcp = new MCPClient({ name: 'search', transport: { ... } });

await Promise.all([fsMcp.connect(), searchMcp.connect()]);

const tools = [
  ...await createMCPTools(fsMcp, { prefix: 'fs_' }),
  ...await createMCPTools(searchMcp, { prefix: 'search_' }),
];

const agent = new Agent({ tools, ... });
```

But for most product scenarios, prefer `MCPToolCenter` + `createMCPCenterTools()` so MCP stays second-class.

## API

### `MCPClient`

- `new MCPClient(config)` — Create a client
- `client.connect()` — Connect to the MCP server
- `client.disconnect()` — Disconnect
- `client.listTools()` — List available tools
- `client.callTool(name, input)` — Call a tool directly

### `createMCPTools(client, options?)`

Convert MCP tools to Berry `ToolRegistration[]`.

Options:
- `prefix?: string` — Prefix for tool names
- `include?: string[]` — Whitelist tool names
- `exclude?: string[]` — Blacklist tool names

### `MCPToolCenter`

A central registry for external MCP servers.

- `register(client)` — Register an MCP client by `client.name`
- `unregister(name)` — Remove a client
- `getClient(name)` — Get a client by name
- `listServers()` — List registered server names
- `listTools(server?)` — List tools across all servers, or one server
- `callTool(server, tool, input)` — Invoke a specific MCP tool on a specific server
- `connectAll()` / `disconnectAll()` — Convenience lifecycle helpers

### `createMCPCenterTools(center, options?)`

Create a compact first-class interface for MCP:

- `list_mcp_tools` — discover tools in the center
- `use_mcp` — call a specific external MCP tool by `{ server, tool, input }`

This is the recommended product-facing mode when MCP servers are extensions rather than core built-in tools.

## License

MIT
