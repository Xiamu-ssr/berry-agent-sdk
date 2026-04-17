// ============================================================
// browser tool — mocked playwright-core tests
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBrowserTool } from '../browser.js';

// ---------- Mock playwright-core ----------

function makeMockPage(overrides: Record<string, any> = {}) {
  const events = new Map<string, Array<(...args: any[]) => void>>();
  const page: any = {
    _events: events,
    on(name: string, fn: (...args: any[]) => void) {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
    },
    once(name: string, fn: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        fn(...args);
        const list = events.get(name);
        if (list) events.set(name, list.filter(h => h !== wrapped));
      };
      this.on(name, wrapped);
    },
    emit(name: string, ...args: any[]) {
      const list = events.get(name);
      if (list) list.forEach(fn => fn(...args));
    },
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue('https://example.com/'),
    title: vi.fn().mockResolvedValue('Example Domain'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    evaluate: vi.fn().mockResolvedValue('Example page text'),
    close: vi.fn().mockResolvedValue(null),
    bringToFront: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(null),
    waitForFunction: vi.fn().mockResolvedValue(null),
    locator: vi.fn((sel: string) => ({
      _selector: sel,
      click: vi.fn().mockResolvedValue(null),
      fill: vi.fn().mockResolvedValue(null),
      focus: vi.fn().mockResolvedValue(null),
      press: vi.fn().mockResolvedValue(null),
      hover: vi.fn().mockResolvedValue(null),
      selectOption: vi.fn().mockResolvedValue(null),
    })),
    keyboard: {
      type: vi.fn().mockResolvedValue(null),
      press: vi.fn().mockResolvedValue(null),
    },
    _snapshotForAI: vi.fn().mockResolvedValue('- button "Submit" [ref=e1]\n- textbox "Email" [ref=e2]'),
    ...overrides,
  };
  return page;
}

function makeMockPw() {
  const pages: any[] = [];
  const context = {
    newPage: vi.fn().mockImplementation(async () => {
      const p = makeMockPage();
      pages.push(p);
      return p;
    }),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(null),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(browser),
    },
    __browser: browser,
    __context: context,
    __pages: pages,
  };
}

// ---------- Tests ----------

describe('browser tool', () => {
  let pw: ReturnType<typeof makeMockPw>;

  beforeEach(() => {
    pw = makeMockPw();
  });

  describe('lazy init', () => {
    it('launches browser only on first call', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      expect(pw.chromium.launch).not.toHaveBeenCalled();

      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(pw.chromium.launch).toHaveBeenCalledTimes(1);

      await tool.execute({ action: 'navigate', url: 'https://other.com' });
      expect(pw.chromium.launch).toHaveBeenCalledTimes(1); // still once
    });

    it('honors headless + viewport options', async () => {
      const tool = createBrowserTool({ _playwright: pw, headless: false, viewport: { width: 1920, height: 1080 } });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(pw.chromium.launch).toHaveBeenCalledWith({ headless: false });
      expect(pw.__browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ viewport: { width: 1920, height: 1080 } }),
      );
    });

    it('returns install error when playwright-core is missing (no _playwright)', async () => {
      const tool = createBrowserTool(); // no _playwright, no peer dep
      const res = await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('playwright-core is not installed');
    });
  });

  describe('navigate', () => {
    it('navigates and returns title', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      const res = await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain('Navigated to');
      expect(res.content).toContain('Example Domain');
    });

    it('errors on missing url', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      const res = await tool.execute({ action: 'navigate' });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/url is required/);
    });
  });

  describe('snapshot', () => {
    it('uses _snapshotForAI when available', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'snapshot' });
      expect(res.content).toContain('[ref=e1]');
      expect(res.content).toContain('Tab t1');
    });

    it('falls back to innerText when _snapshotForAI absent', async () => {
      // Override: first page has no _snapshotForAI
      const page = makeMockPage({ _snapshotForAI: undefined });
      pw.__context.newPage = vi.fn().mockResolvedValue(page);
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'snapshot' });
      expect(res.content).toContain('Example page text');
    });

    it('truncates long snapshots', async () => {
      const longText = 'x'.repeat(50_000);
      const page = makeMockPage({ _snapshotForAI: vi.fn().mockResolvedValue(longText) });
      pw.__context.newPage = vi.fn().mockResolvedValue(page);
      const tool = createBrowserTool({ _playwright: pw, snapshotMaxChars: 1000 });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'snapshot' });
      expect(res.content).toContain('[Truncated:');
      expect(res.content.length).toBeLessThan(1500);
    });
  });

  describe('ref-based interaction', () => {
    it('click resolves aria-ref locator', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'click', ref: 'e1' });
      expect(res.isError).toBeFalsy();
      const page = pw.__pages[0];
      expect(page.locator).toHaveBeenCalledWith('aria-ref=e1');
    });

    it('click falls back to CSS selector for non-ref strings', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'click', ref: 'button.primary' });
      const page = pw.__pages[0];
      expect(page.locator).toHaveBeenCalledWith('button.primary');
    });

    it('type focuses then types via keyboard', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'type', ref: 'e2', text: 'hello@example.com' });
      expect(res.content).toMatch(/Typed \d+ chars/);
      const page = pw.__pages[0];
      expect(page.keyboard.type).toHaveBeenCalledWith('hello@example.com', expect.any(Object));
    });

    it('fill sets input value', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'fill', ref: 'e2', text: 'value' });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain('Filled');
    });

    it('press without ref uses page keyboard', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'press', key: 'Enter' });
      const page = pw.__pages[0];
      expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    });

    it('select passes values array', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'select', ref: 'e3', values: ['red', 'blue'] });
      expect(res.content).toContain('Selected red, blue');
    });

    it('click errors without ref', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'click' });
      expect(res.isError).toBe(true);
    });
  });

  describe('wait', () => {
    it('timeMs uses waitForTimeout', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'wait', timeMs: 500 });
      expect(pw.__pages[0].waitForTimeout).toHaveBeenCalledWith(500);
    });

    it('loadState uses waitForLoadState', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'wait', loadState: 'networkidle' });
      expect(pw.__pages[0].waitForLoadState).toHaveBeenCalledWith('networkidle', expect.any(Object));
    });

    it('text uses waitForFunction', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'wait', text: 'Welcome' });
      expect(pw.__pages[0].waitForFunction).toHaveBeenCalled();
    });

    it('errors when no target given', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'wait' });
      expect(res.isError).toBe(true);
    });
  });

  describe('multi-tab', () => {
    it('tabs action lists all', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'new_tab', url: 'https://other.com' });
      const res = await tool.execute({ action: 'tabs' });
      expect(res.content).toContain('t1');
      expect(res.content).toContain('t2');
      expect(res.content).toContain('▶ t2'); // active
    });

    it('new_tab allocates next id + navigates', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'new_tab', url: 'https://other.com' });
      expect(res.content).toContain('t2');
      expect(res.content).toContain('https://other.com');
    });

    it('switch_tab changes active', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'new_tab' });
      const res = await tool.execute({ action: 'switch_tab', tabId: 't1' });
      expect(res.content).toContain('Switched to tab t1');
    });

    it('close_tab refuses to close the last tab', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'close_tab' });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/last tab/);
    });

    it('close_tab removes and reassigns active', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'new_tab' });
      const res = await tool.execute({ action: 'close_tab', tabId: 't2' });
      expect(res.content).toContain('Closed tab t2');
      expect(res.content).toContain('active is now t1');
    });

    it('actions without tabId target active tab', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'new_tab', url: 'https://other.com' });
      await tool.execute({ action: 'snapshot' });
      // Active is t2, so t2's _snapshotForAI should be called
      expect(pw.__pages[1]._snapshotForAI).toHaveBeenCalled();
    });
  });

  describe('screenshot', () => {
    it('returns data URL', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'screenshot' });
      expect(res.content).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe('evaluate', () => {
    it('returns JSON-stringified result', async () => {
      const page = makeMockPage({ evaluate: vi.fn().mockResolvedValue({ a: 1 }) });
      pw.__context.newPage = vi.fn().mockResolvedValue(page);
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'evaluate', text: 'window.x' });
      expect(res.content).toContain('"a": 1');
    });
  });

  describe('dialog', () => {
    it('registers one-shot dialog accept handler', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'dialog', accept: true, text: 'confirmed' });
      expect(res.content).toContain('accept');
      expect(res.content).toContain('confirmed');
    });
  });

  describe('close', () => {
    it('tears down the browser', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      const res = await tool.execute({ action: 'close' });
      expect(res.content).toBe('Browser closed');
      expect(pw.__browser.close).toHaveBeenCalled();
    });

    it('subsequent call re-launches browser', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      await tool.execute({ action: 'close' });
      await tool.execute({ action: 'navigate', url: 'https://example.com' });
      expect(pw.chromium.launch).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('unknown action returns error', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      const res = await tool.execute({ action: 'bogus' as any });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/unknown action/i);
    });

    it('missing action returns error', async () => {
      const tool = createBrowserTool({ _playwright: pw });
      const res = await tool.execute({});
      expect(res.isError).toBe(true);
    });
  });
});
