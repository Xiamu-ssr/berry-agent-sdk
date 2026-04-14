// ============================================================
// Berry Agent SDK — Common Tools: Browser (Playwright)
// ============================================================
// Playwright is an optional peer dependency — types are not available at compile time.

import { TOOL_BROWSER } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';

export type BrowserAction = 'navigate' | 'snapshot' | 'screenshot' | 'click' | 'type' | 'evaluate';

export interface BrowserToolOptions {
  headless?: boolean;
  timeout?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Create a browser tool powered by Playwright (optional peer dependency).
 * Playwright must be installed separately.
 */
export function createBrowserTool(options?: BrowserToolOptions): ToolRegistration {
  const headless = options?.headless ?? true;
  const timeout = options?.timeout ?? 30_000;

  // Lazily-initialized browser + page (typed as any since playwright is optional)
  let browserPromise: Promise<{ browser: any; page: any }> | null = null;

  async function getPage(): Promise<{ browser: any; page: any }> {
    if (!browserPromise) {
      browserPromise = (async () => {
        // Dynamic import so the module only fails at runtime if playwright isn't installed
        let pw: any;
        try {
          // Use variable to avoid static module resolution check
          const mod = 'playwright';
          pw = await import(/* webpackIgnore: true */ mod);
        } catch {
          throw new Error(
            'Playwright is not installed. Install it with: npm install playwright',
          );
        }
        const browser = await pw.chromium.launch({ headless });
        const page = await browser.newPage();
        page.setDefaultTimeout(timeout);
        return { browser, page };
      })();
    }
    return browserPromise;
  }

  return {
    definition: {
      name: TOOL_BROWSER,
      description:
        'Control a browser via Playwright. Actions: navigate, snapshot, screenshot, click, type, evaluate.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Browser action: navigate, snapshot, screenshot, click, type, evaluate',
          },
          url: { type: 'string', description: 'URL for navigate action' },
          selector: { type: 'string', description: 'CSS selector for click/type actions' },
          text: { type: 'string', description: 'Text for type action or JS code for evaluate action' },
        },
        required: ['action'],
      },
    },
    execute: async (input) => {
      try {
        const action = input.action as BrowserAction;
        const { page } = await getPage();

        switch (action) {
          case 'navigate': {
            const url = input.url as string;
            if (!url) return { content: 'Error: url is required for navigate', isError: true };
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            return { content: `Navigated to ${url} — title: ${await page.title()}` };
          }
          case 'snapshot': {
            const text: string = await page.evaluate(() => document.body.innerText);
            const truncated =
              text.length > 50_000
                ? text.slice(0, 50_000) + '\n[Truncated]'
                : text;
            return { content: truncated };
          }
          case 'screenshot': {
            const buf: Buffer = await page.screenshot({ type: 'png' });
            return { content: `data:image/png;base64,${buf.toString('base64')}` };
          }
          case 'click': {
            const selector = input.selector as string;
            if (!selector) return { content: 'Error: selector is required for click', isError: true };
            await page.click(selector);
            return { content: `Clicked ${selector}` };
          }
          case 'type': {
            const selector = input.selector as string;
            const text = input.text as string;
            if (!selector || !text) {
              return { content: 'Error: selector and text are required for type', isError: true };
            }
            await page.fill(selector, text);
            return { content: `Typed into ${selector}` };
          }
          case 'evaluate': {
            const code = input.text as string;
            if (!code) return { content: 'Error: text (JS code) is required for evaluate', isError: true };
            const result = await page.evaluate(code);
            return { content: String(result ?? '(undefined)') };
          }
          default:
            return { content: `Error: Unknown action "${String(action)}"`, isError: true };
        }
      } catch (err) {
        // Reset browser state on failure so next call can retry
        if (err instanceof Error && err.message.includes('Playwright is not installed')) {
          browserPromise = null;
        }
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
