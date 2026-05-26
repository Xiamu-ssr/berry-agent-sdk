// ============================================================
// Berry Agent SDK — MCP Defaults
// ============================================================
// Defaults are raw on-disk MCP config snippets. Products may choose whether
// to seed them; the SDK owns their shape so hosts do not each invent a
// slightly different `.mcp.json` template.

export const DEFAULT_PLAYWRIGHT_MCP_TEMPLATE = {
  mcpServers: {
    playwright: {
      command: 'npx',
      args: ['@playwright/mcp', '--headless'],
    },
  },
} as const;

export const DEFAULT_PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp' as const;
export const DEFAULT_PLAYWRIGHT_MCP_BIN = 'cli.js' as const;
