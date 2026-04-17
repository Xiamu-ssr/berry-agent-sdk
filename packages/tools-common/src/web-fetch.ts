// ============================================================
// Berry Agent SDK — Common Tools: Web Fetch
// ============================================================
// Extracts readable content from a URL. Pipeline:
//   1. SSRF guard: reject local/private network addresses
//   2. fetch() with timeout and user-agent
//   3. If HTML: sanitize → @mozilla/readability → markdown/text
//   4. Fallback: node-html-markdown on the full page
//   5. Non-HTML: pretty-printed JSON or raw body

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { TOOL_WEB_FETCH } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';
import * as net from 'node:net';
import { promises as dns } from 'node:dns';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const READABILITY_MAX_HTML_CHARS = 2_000_000; // Skip readability on huge pages

export interface WebFetchToolOptions {
  /**
   * Disable the SSRF guard (not recommended outside of tests/trusted env).
   */
  allowPrivateNetwork?: boolean;
  /**
   * Override default max chars cap.
   */
  maxChars?: number;
}

/**
 * Create a web_fetch tool that fetches a URL and extracts readable content.
 * Uses @mozilla/readability (Firefox Reader algorithm) with graceful fallback.
 */
export function createWebFetchTool(options?: WebFetchToolOptions): ToolRegistration {
  const allowPrivateNetwork = options?.allowPrivateNetwork ?? false;
  const defaultMaxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  return {
    definition: {
      name: TOOL_WEB_FETCH,
      description:
        'Fetch a URL and extract readable content (powered by Mozilla Readability). Returns markdown or plain text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch (http/https only)' },
          maxChars: {
            type: 'number',
            description: `Maximum characters to return (default ${defaultMaxChars})`,
          },
          extractMode: {
            type: 'string',
            description: 'Output format: "text" or "markdown" (default "markdown")',
          },
          readability: {
            type: 'boolean',
            description: 'Use Readability for HTML extraction (default true)',
          },
        },
        required: ['url'],
      },
    },
    execute: async (input) => {
      try {
        const url = input.url as string;
        const maxChars = (input.maxChars as number) ?? defaultMaxChars;
        const mode = (input.extractMode as string) ?? 'markdown';
        const useReadability = (input.readability as boolean | undefined) ?? true;

        // 1. SSRF guard
        if (!allowPrivateNetwork) {
          const guardError = await ssrfGuard(url);
          if (guardError) return { content: `Error: ${guardError}`, isError: true };
        }

        // 2. fetch
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'BerryAgent/1.0 (+https://github.com/Xiamu-ssr/berry-agent-sdk)',
            Accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*',
          },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          redirect: 'follow',
        });

        if (!response.ok) {
          return {
            content: `Error: HTTP ${response.status} ${response.statusText}`,
            isError: true,
          };
        }

        // SSRF re-check after redirect
        if (!allowPrivateNetwork) {
          const finalUrl = response.url;
          if (finalUrl && finalUrl !== url) {
            const guardError = await ssrfGuard(finalUrl);
            if (guardError) {
              return { content: `Error: redirect to blocked URL — ${guardError}`, isError: true };
            }
          }
        }

        const contentType = response.headers.get('content-type') ?? '';
        const body = await response.text();

        // 3. Extraction pipeline
        let result: string;
        if (contentType.includes('text/html') || contentType.includes('xhtml')) {
          result = await extractHtml(body, response.url || url, mode, useReadability);
        } else if (contentType.includes('application/json')) {
          try {
            result = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            result = body;
          }
        } else {
          result = body;
        }

        // 4. Truncate
        if (result.length > maxChars) {
          result = result.slice(0, maxChars) + `\n\n[Truncated at ${maxChars} characters]`;
        }

        return { content: result };
      } catch (err) {
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ============================================================
// HTML extraction pipeline
// ============================================================

async function extractHtml(
  html: string,
  url: string,
  mode: string,
  useReadability: boolean,
): Promise<string> {
  // Try Readability first (if enabled and page not absurdly large)
  if (useReadability && html.length <= READABILITY_MAX_HTML_CHARS) {
    try {
      const extracted = await readabilityExtract(html, url);
      if (extracted) {
        const content = mode === 'text' ? stripMarkdownSyntax(extracted.markdown) : extracted.markdown;
        return extracted.title
          ? `# ${extracted.title}\n\n${content}`
          : content;
      }
    } catch {
      // Fall through to markdownify
    }
  }

  // Fallback: markdownify the full document
  const md = NodeHtmlMarkdown.translate(html);
  return mode === 'text' ? stripMarkdownSyntax(md) : md;
}

function stripMarkdownSyntax(md: string): string {
  return md.replace(/[#*_`>[\]()!~|]/g, '').replace(/\n{3,}/g, '\n\n');
}

interface ReadabilityResult {
  title: string | undefined;
  markdown: string;
}

// Lazy-load heavy deps (tree-shaking friendly for environments that skip readability)
/* eslint-disable @typescript-eslint/no-explicit-any */
let readabilityDepsPromise: Promise<{ Readability: any; parseHTML: any } | null> | undefined;

async function loadReadabilityDeps() {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ])
      .then(([r, l]) => ({ Readability: r.Readability, parseHTML: l.parseHTML }))
      .catch(() => null);
  }
  return readabilityDepsPromise;
}

async function readabilityExtract(html: string, url: string): Promise<ReadabilityResult | null> {
  const deps = await loadReadabilityDeps();
  if (!deps) return null;

  const { Readability, parseHTML } = deps;
  const { document } = parseHTML(html);
  try {
    (document as any).baseURI = url;
  } catch {
    // ignore — some linkedom versions are readonly
  }

  const parsed = new Readability(document, { charThreshold: 0 }).parse();
  if (!parsed?.content) return null;

  const markdown = NodeHtmlMarkdown.translate(parsed.content);
  if (!markdown.trim()) return null;

  return {
    title: parsed.title?.trim() || undefined,
    markdown,
  };
}

// ============================================================
// SSRF Guard
// ============================================================
// Blocks:
//   - non-http(s) schemes
//   - localhost / 127.0.0.0/8
//   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
//   - 169.254.0.0/16 (link-local, incl. cloud metadata endpoints)
//   - ::1, fe80::/10, fc00::/7
//   - DNS resolution must not point into private range

async function ssrfGuard(urlString: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return 'invalid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `scheme "${url.protocol}" not allowed (http/https only)`;
  }

  const host = url.hostname;
  if (!host) return 'missing host';

  // Reject obvious bypasses
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost not allowed';
  }

  // If host is already an IP, check directly
  if (net.isIP(host)) {
    if (isPrivateIp(host)) return `private IP ${host} not allowed`;
    return null;
  }

  // Resolve DNS and check each address
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    // If DNS fails, let the actual fetch fail with a meaningful error
    return null;
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      return `${host} resolves to private IP ${addr.address}`;
    }
  }

  return null;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    const [a, b] = parts;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped IPv6: ::ffff:x.x.x.x
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped && isPrivateIp(v4mapped[1])) return true;
    return false;
  }

  return false;
}
