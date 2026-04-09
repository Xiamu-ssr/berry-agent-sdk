# @berry-agent/mcp

MCP (Model Context Protocol) client adapter for [Berry Agent SDK](https://github.com/Xiamu-ssr/berry-agent-sdk).

Connect any MCP server (stdio or HTTP) and use its tools seamlessly with Berry agents.

## Install

```bash
npm install @berry-agent/mcp @berry-agent/core
```

## Quick Start

```typescript
import { Agent } from '@berry-agent/core';
import { MCPClient, createMCPTools } from '@berry-agent/mcp';

// 1. Connect to an MCP server
const mcp = new MCPClient({
  name: 'filesystem',
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  },
});
await mcp.connect();

// 2. Convert MCP tools to Berry tools
const tools = await createMCPTools(mcp, { prefix: 'fs_' });

// 3. Use with Berry Agent
const agent = new Agent({
  provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
  systemPrompt: 'You have filesystem tools available.',
  tools,
});

const result = await agent.query('List files in /tmp');

// 4. Disconnect when done
await mcp.disconnect();
```

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

## License

MIT
