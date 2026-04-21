// ============================================================
// Berry Agent SDK — Common Tools: Browser (Playwright-core)
// ============================================================
// Design notes (inspired by OpenClaw, simplified for SDK use):
//   - Uses playwright-core (optional peer dep); lazy-imported so the module
//     loads even when not installed.
//   - Multi-tab aware. Pages tracked in a Map keyed by a short `tabId`.
//   - Aria snapshot via Playwright's internal `_snapshotForAI()` when
//     available; falls back to `innerText` for ancient playwright-core
//     builds or evaluate-disabled pages.
//   - Ref-based interaction: snapshot yields refs like `e12`. Pass them
//     back as `ref: "e12"` and the tool resolves via `aria-ref=e12` locator.
//     Non-ref strings fall back to CSS selector.
//   - Dialogs: auto-accepted by default; handlers registered per page.
//   - Test injection via `_playwright` option so unit tests can mock
//     the entire module.
//
// This is deliberately a single self-contained file — the tool is the
// whole surface area, no external helpers or sub-modules.

import { TOOL_BROWSER } from '@berry-agent/core';
import type { ToolRegistration } from '@berry-agent/core';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- Public types ----------

export type BrowserAction =
  | 'navigate'
  | 'snapshot'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'fill'
  | 'press'
  | 'hover'
  | 'select'
  | 'wait'
  | 'evaluate'
  | 'tabs'
  | 'new_tab'
  | 'close_tab'
  | 'switch_tab'
  | 'dialog'
  | 'close';

export interface BrowserToolOptions {
  /** Launch in headless mode (default true). */
  headless?: boolean;
  /** Per-action timeout ms (default 30s). */
  timeout?: number;
  /** Upper bound on snapshot text length (default 25_000 chars). */
  snapshotMaxChars?: number;
  /** User-agent override. */
  userAgent?: string;
  /** Default viewport. */
  viewport?: { width: number; height: number };
  /** Inject a mock playwright-core module (testing). */
  _playwright?: any;
}

// ---------- Module-private state ----------

interface TabInfo {
  id: string;
  page: any; // playwright Page
  consoleBuffer: Array<{ level: string; text: string; at: number }>;
}

interface BrowserCtx {
  browser: any;
  context: any;
  tabs: Map<string, TabInfo>;
  activeTabId: string;
}

// ---------- Utilities ----------

function nextTabId(ctx: BrowserCtx): string {
  for (let i = 1; i < 1000; i++) {
    const id = `t${i}`;
    if (!ctx.tabs.has(id)) return id;
  }
  throw new Error('Too many tabs (>= 1000) — close some first');
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n[Truncated: ${text.length - cap} more chars]`;
}

/**
 * Resolve a ref like "e12" into an aria-ref locator. CSS selectors / XPath
 * pass through unchanged.
 */
function resolveLocator(page: any, ref: string): any {
  // aria-ref pattern: one letter + digits (e.g. e12, f3)
  if (/^[a-z]\d+$/.test(ref)) {
    return page.locator(`aria-ref=${ref}`);
  }
  return page.locator(ref);
}

/**
 * Best-effort aria snapshot. Tries Playwright's internal `_snapshotForAI()`
 * first, which yields ref-tagged aria text; falls back to innerText.
 */
async function captureSnapshot(page: any): Promise<string> {
  const maybe = page as any;
  if (typeof maybe._snapshotForAI === 'function') {
    try {
      const snap = await maybe._snapshotForAI({ timeout: 5000 });
      if (typeof snap === 'string' && snap.trim().length > 0) return snap;
    } catch {
      // fall through to innerText
    }
  }
  // Fallback: innerText (no refs, but still readable)
  try {
    const text: string = await page.evaluate(() => document.body?.innerText ?? '');
    return text;
  } catch {
    return '(page has no accessible content)';
  }
}

// ---------- Tool factory ----------

/**
 * Create the browser tool. Playwright-core must be installed as a peer dep
 * (>=1.50.0 for `_snapshotForAI` support; older versions fall back to
 * innerText snapshots automatically).
 */
export function createBrowserTool(options: BrowserToolOptions = {}): ToolRegistration {
  const headless = options.headless ?? true;
  const timeout = options.timeout ?? 30_000;
  const snapshotMaxChars = options.snapshotMaxChars ?? 25_000;

  let ctxPromise: Promise<BrowserCtx> | null = null;

  async function getCtx(): Promise<BrowserCtx> {
    if (ctxPromise) return ctxPromise;

    ctxPromise = (async () => {
      let pw: any;
      if (options._playwright) {
        pw = options._playwright;
      } else {
        try {
          const mod = 'playwright-core';
          pw = await import(/* webpackIgnore: true */ mod);
        } catch {
          // When tools-common is consumed via file: link (e.g. berry-claw → SDK monorepo),
          // the dynamic import resolves relative to dist/browser.js inside the SDK, which
          // may not have playwright-core in its own node_modules.  Try resolving from the
          // consumer's working directory as a fallback.
          try {
            const { createRequire } = await import('node:module');
            const consumerRequire = createRequire(process.cwd() + '/__browser__.js');
            pw = consumerRequire('playwright-core');
          } catch {
            throw new Error(
              'playwright-core is not installed. Install it with: npm install playwright-core',
            );
          }
        }
      }

      const browser = await pw.chromium.launch({ headless });
      const context = await browser.newContext({
        userAgent: options.userAgent,
        viewport: options.viewport ?? { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);

      const tabs = new Map<string, TabInfo>();
      const firstId = 't1';
      const tab: TabInfo = { id: firstId, page, consoleBuffer: [] };
      attachTabListeners(tab);
      tabs.set(firstId, tab);

      return { browser, context, tabs, activeTabId: firstId };
    })();

    return ctxPromise;
  }

  function attachTabListeners(tab: TabInfo): void {
    tab.page.on('console', (msg: any) => {
      tab.consoleBuffer.push({
        level: msg.type(),
        text: msg.text(),
        at: Date.now(),
      });
      // Cap buffer at 200 entries
      if (tab.consoleBuffer.length > 200) tab.consoleBuffer.shift();
    });
    // Auto-accept dialogs unless overridden via the `dialog` action
    tab.page.on('dialog', (dialog: any) => {
      dialog.accept().catch(() => {});
    });
  }

  async function getActiveTab(ctx: BrowserCtx, requested?: string): Promise<TabInfo> {
    const id = requested ?? ctx.activeTabId;
    const tab = ctx.tabs.get(id);
    if (!tab) throw new Error(`Tab "${id}" not found. Call action=tabs to list.`);
    return tab;
  }

  async function reset(): Promise<void> {
    if (!ctxPromise) return;
    try {
      const ctx = await ctxPromise;
      await ctx.browser.close().catch(() => {});
    } catch {
      // ignore
    }
    ctxPromise = null;
  }

  // ---------- Action dispatch ----------

  async function executeAction(
    action: BrowserAction,
    input: Record<string, any>,
  ): Promise<{ content: string; isError?: boolean }> {
    const ctx = await getCtx();
    const tabId = typeof input.tabId === 'string' ? input.tabId : undefined;

    switch (action) {
      case 'navigate': {
        const url = typeof input.url === 'string' ? input.url : '';
        if (!url) return { content: 'Error: url is required for navigate', isError: true };
        const tab = await getActiveTab(ctx, tabId);
        const waitUntil = typeof input.waitUntil === 'string' ? input.waitUntil : 'domcontentloaded';
        await tab.page.goto(url, { waitUntil });
        const title = await tab.page.title().catch(() => '');
        return { content: `Navigated to ${tab.page.url()} — title: ${title || '(no title)'}` };
      }

      case 'snapshot': {
        const tab = await getActiveTab(ctx, tabId);
        const snap = await captureSnapshot(tab.page);
        const url = tab.page.url();
        const title = await tab.page.title().catch(() => '');
        const header = `# Tab ${tab.id} — ${title || '(no title)'}\nURL: ${url}\n\n`;
        return { content: header + truncate(snap, snapshotMaxChars) };
      }

      case 'screenshot': {
        const tab = await getActiveTab(ctx, tabId);
        const fullPage = Boolean(input.fullPage);
        const buf: Buffer = await tab.page.screenshot({ type: 'png', fullPage });
        return { content: `data:image/png;base64,${buf.toString('base64')}` };
      }

      case 'click': {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        if (!ref) return { content: 'Error: ref (aria-ref or CSS selector) is required', isError: true };
        const tab = await getActiveTab(ctx, tabId);
        const locator = resolveLocator(tab.page, ref);
        const clickCount = typeof input.clickCount === 'number' ? input.clickCount : 1;
        const button = (input.button as 'left' | 'right' | 'middle') ?? 'left';
        await locator.click({ clickCount, button });
        return { content: `Clicked ${ref}` };
      }

      case 'type': {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const text = typeof input.text === 'string' ? input.text : '';
        if (!ref || text === '') {
          return { content: 'Error: ref and text are required for type', isError: true };
        }
        const tab = await getActiveTab(ctx, tabId);
        const locator = resolveLocator(tab.page, ref);
        await locator.focus();
        await tab.page.keyboard.type(text, { delay: typeof input.delayMs === 'number' ? input.delayMs : 0 });
        return { content: `Typed ${text.length} chars into ${ref}` };
      }

      case 'fill': {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const text = typeof input.text === 'string' ? input.text : '';
        if (!ref) return { content: 'Error: ref is required for fill', isError: true };
        const tab = await getActiveTab(ctx, tabId);
        const locator = resolveLocator(tab.page, ref);
        await locator.fill(text);
        return { content: `Filled ${ref} with ${text.length} chars` };
      }

      case 'press': {
        const key = typeof input.key === 'string' ? input.key : '';
        if (!key) return { content: 'Error: key is required for press', isError: true };
        const tab = await getActiveTab(ctx, tabId);
        const ref = typeof input.ref === 'string' ? input.ref : '';
        if (ref) {
          await resolveLocator(tab.page, ref).press(key);
        } else {
          await tab.page.keyboard.press(key);
        }
        return { content: `Pressed ${key}${ref ? ` on ${ref}` : ''}` };
      }

      case 'hover': {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        if (!ref) return { content: 'Error: ref is required for hover', isError: true };
        const tab = await getActiveTab(ctx, tabId);
        await resolveLocator(tab.page, ref).hover();
        return { content: `Hovered ${ref}` };
      }

      case 'select': {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const values = Array.isArray(input.values) ? (input.values as string[]) : [];
        if (!ref || values.length === 0) {
          return { content: 'Error: ref and values[] are required for select', isError: true };
        }
        const tab = await getActiveTab(ctx, tabId);
        await resolveLocator(tab.page, ref).selectOption(values);
        return { content: `Selected ${values.join(', ')} on ${ref}` };
      }

      case 'wait': {
        const tab = await getActiveTab(ctx, tabId);
        const timeMs = typeof input.timeMs === 'number' ? input.timeMs : undefined;
        const loadState = typeof input.loadState === 'string' ? input.loadState : undefined;
        const text = typeof input.text === 'string' ? input.text : undefined;
        if (timeMs !== undefined) {
          await tab.page.waitForTimeout(Math.max(0, Math.min(timeMs, 60_000)));
          return { content: `Waited ${timeMs}ms` };
        }
        if (loadState) {
          await tab.page.waitForLoadState(loadState, { timeout });
          return { content: `Reached load state: ${loadState}` };
        }
        if (text) {
          await tab.page.waitForFunction(
            (needle: string) => document.body?.innerText?.includes(needle) ?? false,
            text,
            { timeout },
          );
          return { content: `Text appeared: ${text}` };
        }
        return { content: 'Error: wait requires timeMs, loadState, or text', isError: true };
      }

      case 'evaluate': {
        const tab = await getActiveTab(ctx, tabId);
        const code = typeof input.text === 'string' ? input.text : '';
        if (!code) return { content: 'Error: text (JS expression) is required', isError: true };
        const result = await tab.page.evaluate(code);
        try {
          return { content: JSON.stringify(result, null, 2) };
        } catch {
          return { content: String(result ?? '(undefined)') };
        }
      }

      case 'tabs': {
        const list = await Promise.all(
          [...ctx.tabs.values()].map(async (tab) => {
            const url = tab.page.url();
            const title = await tab.page.title().catch(() => '');
            const active = tab.id === ctx.activeTabId;
            return `${active ? '▶ ' : '  '}${tab.id} · ${title || '(no title)'} · ${url}`;
          }),
        );
        return { content: list.join('\n') || '(no tabs)' };
      }

      case 'new_tab': {
        const id = nextTabId(ctx);
        const page = await ctx.context.newPage();
        page.setDefaultTimeout(timeout);
        const tab: TabInfo = { id, page, consoleBuffer: [] };
        attachTabListeners(tab);
        ctx.tabs.set(id, tab);
        ctx.activeTabId = id;
        const url = typeof input.url === 'string' ? input.url : '';
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { content: `Opened tab ${id}${url ? ` → ${url}` : ''}` };
      }

      case 'close_tab': {
        const targetId = tabId ?? ctx.activeTabId;
        const tab = ctx.tabs.get(targetId);
        if (!tab) return { content: `Error: tab "${targetId}" not found`, isError: true };
        if (ctx.tabs.size === 1) {
          return { content: 'Error: cannot close the last tab; use action=close to shut down the browser', isError: true };
        }
        await tab.page.close().catch(() => {});
        ctx.tabs.delete(targetId);
        if (ctx.activeTabId === targetId) {
          ctx.activeTabId = ctx.tabs.keys().next().value as string;
        }
        return { content: `Closed tab ${targetId}; active is now ${ctx.activeTabId}` };
      }

      case 'switch_tab': {
        const targetId = tabId ?? '';
        if (!ctx.tabs.has(targetId)) {
          return { content: `Error: tab "${targetId}" not found`, isError: true };
        }
        ctx.activeTabId = targetId;
        await ctx.tabs.get(targetId)!.page.bringToFront().catch(() => {});
        return { content: `Switched to tab ${targetId}` };
      }

      case 'dialog': {
        // Register a one-shot handler for the next dialog.
        const tab = await getActiveTab(ctx, tabId);
        const accept = input.accept !== false;
        const promptText = typeof input.text === 'string' ? input.text : undefined;
        tab.page.once('dialog', (dialog: any) => {
          if (accept) dialog.accept(promptText).catch(() => {});
          else dialog.dismiss().catch(() => {});
        });
        return { content: `Registered dialog handler: ${accept ? 'accept' : 'dismiss'}${promptText ? ` with text="${promptText}"` : ''}` };
      }

      case 'close': {
        await reset();
        return { content: 'Browser closed' };
      }

      default:
        return { content: `Error: unknown action "${String(action)}"`, isError: true };
    }
  }

  return {
    definition: {
      name: TOOL_BROWSER,
      description:
        'Control a Chromium browser via Playwright. ' +
        'Snapshot action returns an aria tree with refs (e.g. "e12"); pass refs back as ref="e12" to click/type/etc. ' +
        'Supports multi-tab via tabId. Actions: navigate, snapshot, screenshot, click, type, fill, press, hover, select, wait, evaluate, tabs, new_tab, close_tab, switch_tab, dialog, close.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'One of: navigate, snapshot, screenshot, click, type, fill, press, hover, select, wait, evaluate, tabs, new_tab, close_tab, switch_tab, dialog, close',
          },
          url: { type: 'string', description: 'URL for navigate / new_tab' },
          ref: {
            type: 'string',
            description:
              'aria-ref (e.g. "e12") from a snapshot, or CSS selector. Used by click/type/fill/press/hover/select.',
          },
          text: {
            type: 'string',
            description: 'Text input for type/fill, JS expression for evaluate, text to wait for in wait, prompt text for dialog.',
          },
          key: { type: 'string', description: 'Keyboard key name for press (e.g. "Enter", "Tab", "Escape").' },
          values: { type: 'array', items: { type: 'string' }, description: 'Values for select.' },
          timeMs: { type: 'number', description: 'Duration for wait action (<= 60s).' },
          loadState: {
            type: 'string',
            description: 'Target load state for wait (load, domcontentloaded, networkidle).',
          },
          tabId: { type: 'string', description: 'Tab identifier (e.g. "t1"). Defaults to active tab.' },
          fullPage: { type: 'boolean', description: 'Capture full-page screenshot.' },
          clickCount: { type: 'number', description: 'Click count (1 = single, 2 = double).' },
          button: { type: 'string', description: 'Mouse button: left | middle | right.' },
          waitUntil: { type: 'string', description: 'navigate waitUntil: load | domcontentloaded | networkidle.' },
          accept: { type: 'boolean', description: 'Accept or dismiss next dialog (default true).' },
          delayMs: { type: 'number', description: 'Per-keystroke delay for type action.' },
        },
        required: ['action'],
      },
    },
    execute: async (input) => {
      try {
        const action = input.action as BrowserAction;
        if (!action) return { content: 'Error: action is required', isError: true };
        return await executeAction(action, input as Record<string, any>);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Reset browser on fatal-looking errors so next call can retry cleanly
        if (/playwright-core is not installed|browser has been closed|Target page/i.test(msg)) {
          await reset();
        }
        return { content: `Error: ${msg}`, isError: true };
      }
    },
  };
}
