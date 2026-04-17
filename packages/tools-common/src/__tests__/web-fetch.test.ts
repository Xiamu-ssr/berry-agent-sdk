// ============================================================
// web_fetch — readability + SSRF guard
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebFetchTool } from '../web-fetch.js';

describe('createWebFetchTool', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(body: string, contentType = 'text/html; charset=utf-8', url = 'https://example.com/article'): void {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: new Map([['content-type', contentType]]) as unknown as Headers,
      text: async () => body,
    } as unknown as Response);
  }

  describe('SSRF guard', () => {
    it('blocks localhost', async () => {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'http://localhost:8080/api' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/localhost not allowed/);
    });

    it('blocks 127.0.0.1', async () => {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'http://127.0.0.1/api' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/private IP/);
    });

    it('blocks cloud metadata endpoint (169.254.169.254)', async () => {
      const tool = createWebFetchTool();
      const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/private IP/);
    });

    it('blocks RFC1918 (10.x, 172.16-31.x, 192.168.x)', async () => {
      const tool = createWebFetchTool();
      for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
        const res = await tool.execute({ url: `http://${ip}/` });
        expect(res.isError).toBe(true);
      }
    });

    it('blocks non-http(s) schemes', async () => {
      const tool = createWebFetchTool();
      for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/']) {
        const res = await tool.execute({ url });
        expect(res.isError).toBe(true);
        expect(res.content).toMatch(/scheme/);
      }
    });

    it('blocks IPv6 loopback', async () => {
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'http://[::1]/' });
      expect(res.isError).toBe(true);
    });

    it('can be disabled via allowPrivateNetwork', async () => {
      // Must mock fetch BEFORE creating the tool (constructor may take options)
      mockFetch('<html><body>ok</body></html>');
      const tool = createWebFetchTool({ allowPrivateNetwork: true });
      const result = await tool.execute({ url: 'http://127.0.0.1/' });
      // No SSRF block; result should NOT be an SSRF error
      if (result.isError) {
        expect(result.content).not.toMatch(/private IP/);
      }
    });
  });

  describe('HTML extraction', () => {
    it('returns markdown for HTML content', async () => {
      mockFetch(
        '<html><body><h1>Hello</h1><p>This is a paragraph with enough content to pass the readability threshold. '.repeat(20) + '</p></body></html>',
      );
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/a' });
      expect(res.isError).toBeFalsy();
      expect(typeof res.content).toBe('string');
      expect(res.content.length).toBeGreaterThan(0);
    });

    it('honors maxChars cap', async () => {
      const bigHtml = '<html><body><p>' + 'x'.repeat(100_000) + '</p></body></html>';
      mockFetch(bigHtml);
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/a', maxChars: 500 });
      expect(res.content.length).toBeLessThan(600); // 500 + truncation notice
      expect(res.content).toContain('Truncated');
    });

    it('text mode strips markdown syntax', async () => {
      mockFetch(
        '<html><body><h1>Title</h1><p>' + 'content word '.repeat(30) + '</p></body></html>',
      );
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/a', extractMode: 'text' });
      expect(res.content).not.toMatch(/^#/m);
    });

    it('readability can be disabled', async () => {
      mockFetch('<html><body><article><h1>T</h1><p>' + 'content '.repeat(50) + '</p></article></body></html>');
      const tool = createWebFetchTool();
      const res = await tool.execute({
        url: 'https://example.com/a',
        readability: false,
      });
      expect(res.isError).toBeFalsy();
      expect(res.content).toBeTruthy();
    });
  });

  describe('non-HTML content', () => {
    it('pretty-prints JSON', async () => {
      mockFetch('{"a":1,"b":2}', 'application/json');
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/api' });
      expect(res.content).toContain('"a": 1');
      expect(res.content).toContain('"b": 2');
    });

    it('passes through plain text', async () => {
      mockFetch('hello world', 'text/plain');
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/txt' });
      expect(res.content).toBe('hello world');
    });
  });

  describe('error handling', () => {
    it('reports HTTP errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        url: 'https://example.com/x',
        headers: new Map() as unknown as Headers,
        text: async () => '',
      } as unknown as Response);

      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/x' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('HTTP 404');
    });

    it('reports fetch errors', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
      const tool = createWebFetchTool();
      const res = await tool.execute({ url: 'https://example.com/x' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('network down');
    });
  });
});
