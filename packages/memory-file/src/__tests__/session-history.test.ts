// ============================================================
// @berry-agent/memory-file — Session history provider tests
// ============================================================

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@berry-agent/core';
import { createSessionHistoryProvider } from '../session-history.js';

function userEvent(sessionId: string, text: string, id = `evt_${Math.random().toString(36).slice(2)}`): SessionEvent {
  return {
    id,
    timestamp: Date.now(),
    sessionId,
    type: 'user_message',
    content: text,
  };
}

function assistantEvent(sessionId: string, text: string, id = `evt_${Math.random().toString(36).slice(2)}`): SessionEvent {
  return {
    id,
    timestamp: Date.now(),
    sessionId,
    type: 'assistant_message',
    content: [{ type: 'text', text }],
  };
}

describe('createSessionHistoryProvider', () => {
  it('indexes user + assistant text events and finds them via search', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-'));
    const provider = createSessionHistoryProvider({ workspaceDir: root });

    provider.ingest('s1', userEvent('s1', 'I love bonsai trees and traditional Japanese gardens', 'e1'));
    provider.ingest('s1', assistantEvent('s1', 'Bonsai cultivation requires patience and seasonal care', 'e2'));
    provider.ingest('s2', userEvent('s2', 'Show me the React component for the dashboard header', 'e3'));

    const bonsai = provider.search('bonsai');
    expect(bonsai.length).toBeGreaterThan(0);
    expect(bonsai[0].sessionId).toBe('s1');

    const react = provider.search('React component');
    expect(react.length).toBeGreaterThan(0);
    expect(react[0].sessionId).toBe('s2');

    provider.dispose();
  });

  it('skips non-message events', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-'));
    const provider = createSessionHistoryProvider({ workspaceDir: root });

    // tool_use_start event should NOT show up in keyword search
    provider.ingest('s1', {
      id: 'e1',
      timestamp: Date.now(),
      sessionId: 's1',
      type: 'tool_use_start',
      toolUseId: 'tu_1',
      name: 'unicorn_grep',
      input: { pattern: 'something' },
    } as SessionEvent);

    expect(provider.search('unicorn_grep').length).toBe(0);
    provider.dispose();
  });

  it('exposes a search_session_history tool that returns formatted snippets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-'));
    const provider = createSessionHistoryProvider({ workspaceDir: root });
    provider.ingest('s1', userEvent('s1', 'remember that the customer Alice prefers TypeScript', 'e1'));

    const tools = provider.tools();
    const search = tools.find((t) => t.definition.name === 'search_session_history')!;
    expect(search).toBeDefined();

    const result = await search.execute({ query: 'Alice TypeScript' }, { cwd: root });
    expect(result.isError).not.toBe(true);
    expect(result.content).toMatch(/Alice/);
    expect(result.content).toMatch(/session=s1/);

    const noMatch = await search.execute({ query: 'something completely unrelated unicorn' }, { cwd: root });
    expect(noMatch.content).toMatch(/No session history matches/);

    provider.dispose();
  });

  it('attach hooks into a subscribe function so live events get indexed', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-'));
    const provider = createSessionHistoryProvider({ workspaceDir: root });

    // Simulate the SDK's subscribeSessionEvents shape.
    const listeners: Array<(sessionId: string, event: SessionEvent) => void> = [];
    const subscribe = (l: (sessionId: string, event: SessionEvent) => void) => {
      listeners.push(l);
      return () => { listeners.splice(listeners.indexOf(l), 1); };
    };

    const unsub = provider.attach(subscribe);
    expect(listeners.length).toBe(1);

    // Now fire an event through the listener.
    listeners[0]('s9', userEvent('s9', 'quantum entanglement and bell inequalities', 'e9'));
    const hits = provider.search('quantum entanglement');
    expect(hits.length).toBeGreaterThan(0);

    unsub();
    expect(listeners.length).toBe(0);
    provider.dispose();
  });
});
