// ============================================================
// Berry Agent SDK — Common Tools: Web Fetch
// ============================================================

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { TOOL_WEB_FETCH } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';

const DEFAULT_MAX_CHARS = 50_000;

/**
 * Create a web_fetch tool that fetches a URL and extracts readable content.
 * Uses native fetch() + node-html-markdown for HTML-to-text conversion.
 */
export function createWebFetchTool(): ToolRegistration {
  return {
    definition: {
      name: TOOL_WEB_FETCH,
      description: 'Fetch a URL and extract readable content as text or markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          maxChars: { type: 'number', description: 'Maximum characters to return (default 50000)' },
          extractMode: {
            type: 'string',
            description: 'Output format: "text" or "markdown" (default "markdown")',
          },
        },
        required: ['url'],
      },
    },
    execute: async (input) => {
      try {
        const url = input.url as string;
        const maxChars = (input.maxChars as number) ?? DEFAULT_MAX_CHARS;
        const mode = (input.extractMode as string) ?? 'markdown';

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'BerryAgent/1.0',
            Accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*',
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          return {
            content: `Error: HTTP ${response.status} ${response.statusText}`,
            isError: true,
          };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await response.text();

        let result: string;
        if (contentType.includes('text/html') || contentType.includes('xhtml')) {
          if (mode === 'text') {
            // Strip tags for plain text
            result = NodeHtmlMarkdown.translate(body)
              .replace(/[#*_`>\[\]()!~|]/g, '')
              .replace(/\n{3,}/g, '\n\n');
          } else {
            result = NodeHtmlMarkdown.translate(body);
          }
        } else {
          // Non-HTML: return raw body (JSON, plain text, etc.)
          result = body;
        }

        if (result.length > maxChars) {
          result = result.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} characters]`;
        }

        return { content: result };
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
