// ============================================================
// @berry-agent/client — AgentHandle
// ============================================================
// Ergonomic per-agent surface for products. Wraps A8sClient with the
// agentId bound, and adds the one thing the raw client can't express as a
// request/response: a live SSE subscription to the agent's event stream.
//
// This is the product data plane. A product (berry-claw etc.) holds an
// AgentHandle per open agent and drives it entirely over a8s — no local
// runtime, no engine. "berry-claw has no backend; a8s is its backend."

import {
  A8S_PATHS,
  ADMIN_AUTH_HEADER,
  SSE_LAST_EVENT_ID_HEADER,
  type AgentHomeDoc,
  type AgentSpecPatchRequest,
  type SendRequest,
  type SendResponse,
  type SessionEventsResponse,
  type SessionListResponse,
} from '@berry-agent/cluster-protocol';
import type { A8sClient } from './a8s-client.js';

/** One server-sent event from an agent's stream. */
export interface AgentStreamEvent {
  /** SSE id (the SessionEvent id) — usable as Last-Event-ID for resume. */
  id: string;
  /** SSE event type (the SessionEvent type). */
  type: string;
  /** Parsed SessionEvent payload (SDK shape, opaque here). */
  data: Record<string, unknown>;
}

export interface SubscribeOptions {
  /** Narrow the stream to one session; omit for all of the agent's sessions. */
  sessionId?: string;
  /** Resume after this event id (server replays everything after it). */
  lastEventId?: string;
  /** AbortSignal to close the stream. */
  signal?: AbortSignal;
}

export class AgentHandle {
  constructor(
    private readonly client: A8sClient,
    readonly agentId: string,
  ) {}

  /** Send a turn; live events stream to `onEvent`, resolves with the result. */
  send(input: SendRequest, onEvent?: (event: Record<string, unknown>) => void): Promise<SendResponse> {
    return this.client.sendToAgent(this.agentId, input, onEvent);
  }

  listSessions(): Promise<SessionListResponse> {
    return this.client.listSessions(this.agentId);
  }

  listSessionEvents(
    sessionId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<SessionEventsResponse> {
    return this.client.listSessionEvents(this.agentId, sessionId, opts);
  }

  // ----- Session write ops (D-sessions, agentId bound) -----
  createSession() { return this.client.createSession(this.agentId); }
  getSession(sessionId: string) { return this.client.getSession(this.agentId, sessionId); }
  deleteSession(sessionId: string) { return this.client.deleteSession(this.agentId, sessionId); }
  clearSession(sessionId: string) { return this.client.clearSession(this.agentId, sessionId); }
  getSessionTodos(sessionId: string) { return this.client.getSessionTodos(this.agentId, sessionId); }

  // ----- Config & introspection (delegate to the client, agentId bound) -----

  readHome(doc: AgentHomeDoc) { return this.client.readAgentHome(this.agentId, doc); }
  writeHome(doc: AgentHomeDoc, content: string) { return this.client.writeAgentHome(this.agentId, doc, content); }
  patchSpec(patch: AgentSpecPatchRequest) { return this.client.patchAgentSpec(this.agentId, patch); }
  status() { return this.client.agentStatus(this.agentId); }
  contextSize(sessionId?: string) { return this.client.agentContextSize(this.agentId, sessionId); }
  pause(reason?: string) { return this.client.pauseAgent(this.agentId, reason); }
  interject(text: string) { return this.client.interjectAgent(this.agentId, text); }

  /**
   * Subscribe to the agent's live event stream over SSE, as an async
   * iterable. Each yielded event is `{ id, type, data }`. The stream runs
   * until the server closes it or `opts.signal` aborts.
   *
   * We hand-parse SSE rather than use EventSource because EventSource
   * can't send the Authorization header a8s requires. Resume is automatic
   * for a caller that passes the last seen `id` back as `lastEventId`.
   *
   * Usage:
   *   for await (const ev of handle.subscribe({ sessionId })) { ... }
   */
  async *subscribe(opts: SubscribeOptions = {}): AsyncGenerator<AgentStreamEvent> {
    const q = new URLSearchParams();
    if (opts.sessionId) q.set('session', opts.sessionId);
    const qs = q.toString();
    const path = A8S_PATHS.agentEventsStream(this.agentId) + (qs ? `?${qs}` : '');
    const headers: Record<string, string> = {
      [ADMIN_AUTH_HEADER]: await this.client.authHeader(),
      accept: 'text/event-stream',
    };
    if (opts.lastEventId) headers[SSE_LAST_EVENT_ID_HEADER] = opts.lastEventId;

    const resp = await this.client.fetchFn(`${this.client.url}${path}`, { headers, signal: opts.signal });
    if (!resp.ok || !resp.body) {
      throw new Error(`a8s SSE subscribe failed: HTTP ${resp.status}`);
    }
    yield* streamSseFrames(resp.body);
  }
}

/**
 * Parse a fetch Response body stream into SSE frames. Shared by every SSE
 * consumer in the client (event subscribe + the streaming send turn) so
 * there is one SSE parser, not several. Yields `{id,type,data}` per frame.
 */
export async function* streamSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AgentStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSseFrame(frame);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Parse one SSE frame ("id:/event:/data:" lines). Returns null for comments/keepalives. */
function parseSseFrame(frame: string): AgentStreamEvent | null {
  let id = '';
  let type = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = val;
    else if (field === 'event') type = val;
    else if (field === 'data') dataLines.push(val);
  }
  if (dataLines.length === 0) return null;
  try {
    return { id, type, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}
