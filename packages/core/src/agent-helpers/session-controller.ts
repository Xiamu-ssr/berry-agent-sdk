// ============================================================
// SessionController — session lifecycle + crash recovery + session views
// ============================================================
// Extracted from agent.ts to keep the god class thin. Owns the
// `crashCheckedSessions` per-process cache internally so Agent doesn't
// have to. Mutable Agent state (provider, providerConfig, systemPrompt,
// tools) is accessed through getter callbacks so the controller never
// holds stale refs after Agent.switchModel() / setSystemPrompt() /
// addTool().

import type { SystemPromptBlock } from '@berry-agent/small-shared-core';
import { normalizeSystemPrompt } from '@berry-agent/small-shared-core';
import type {
  AgentEvent,
  CreateSessionOptions,
  QueryOptions,
} from '../agent-runtime-types.js';
import type { CompactionConfig, CompactionStrategy } from '../compaction/types.js';
import type { Provider, ProviderConfig } from '../provider-types.js';
import type { Session, SessionStore, TodoItem } from '../session-types.js';
import type { ToolRegistration } from '../tool-types.js';
import { toAgentSessionSummary, toAgentSessionView } from '../chat.js';
import type { AgentSessionView } from '../chat-types.js';
import type { CompactionResult } from '../compaction/compactor.js';
import type { EventLogStore, SessionEvent, SessionEventDraft, SessionEventType } from '../event-log/types.js';
import type { PromptPack } from '../prompts.js';
import { detectCrashArtifacts, formatCrashInterject } from '../event-log/crash-detector.js';
import type { AgentMemory, ProjectContext } from '../workspace/types.js';
import { createEmptySessionMetadata } from './session.js';
import { generateEventId, generateId } from './ids.js';
import { compactSessionMessages } from './session-compaction.js';

const UI_EVENT_TYPES: SessionEventType[] = [
  'user_message',
  'assistant_message',
  'tool_use',
  'tool_result',
  'thinking',
  'query_start',
  'query_end',
  'compaction_marker',
  'guard_decision',
  'approval_request',
  'approval_decision',
  'delegate_start',
  'delegate_end',
  'api_call',
  'memory_flush',
  'metadata',
  'session_start',
  'api_response',
  'tool_use_start',
  'tool_use_end',
  'crash_recovered',
];

const SESSION_DETAIL_EVENT_LIMIT = 600;
const SESSION_LIST_EVENT_LIMIT = 80;

/**
 * Live-ref dependency bag. Fields that can be changed by Agent runtime
 * controls are exposed as getters so the controller never keeps stale facts.
 */
export interface SessionControllerDeps {
  readonly sessionStore: SessionStore;
  readonly eventLogStore?: EventLogStore;
  readonly toolGuardEnabled: boolean;

  /** Live reads of state that Agent may replace or learn at runtime. */
  getProjectContext(): ProjectContext | undefined;
  getMemory(): AgentMemory | undefined;
  getCompactionConfig(): CompactionConfig | undefined;
  getCompactionStrategy(): CompactionStrategy | undefined;
  getProvider(): Provider;
  getProviderConfig(): ProviderConfig;
  getSystemPrompt(): readonly SystemPromptBlock[];
  getPromptPack(): PromptPack;
  getTools(): ReadonlyMap<string, ToolRegistration>;

  /** Inject a crash-recovery notice into the currently-running query. */
  interject(text: string): void;
  /** Emit to Agent's onEvent plus an optional per-query onEvent. */
  emit(event: AgentEvent, onEvent?: (event: AgentEvent) => void): void;
  /** Build the full system prompt (skills + AGENTS.md etc.) for manual compaction. */
  buildSystemPrompt(base: readonly SystemPromptBlock[]): Promise<SystemPromptBlock[]>;
}

/**
 * Stateful session helper. Encapsulates the one piece of mutable state
 * session management needs (crash-detection dedup per process) and delegates
 * everything else to the injected {@link SessionControllerDeps}.
 */
export class SessionController {
  private readonly crashCheckedSessions = new Set<string>();

  constructor(private readonly deps: SessionControllerDeps) {}

  /** Resolve or build the session for a new query turn (resume / fork / fresh). */
  async resolveSession(options?: QueryOptions): Promise<Session> {
    const d = this.deps;
    if (options?.resume) {
      // messages.json is authoritative — Agent.save() writes it atomically after
      // every tool loop turn, so it reflects the last committed state of the
      // conversation. Event log stays for crash detection + audit but is no
      // longer the source of truth for resume.
      const session = await d.sessionStore.load(options.resume);
      if (!session) throw new Error(`Session not found: ${options.resume}`);

      // Crash recovery: if the event log has more turns than messages.json
      // committed, the process died mid-turn. Detect orphaned tool calls and
      // warn the LLM via interject. Runs once per session per process.
      if (d.eventLogStore && !this.crashCheckedSessions.has(options.resume)) {
        this.crashCheckedSessions.add(options.resume);
        const events = await d.eventLogStore.getEvents(options.resume);
        if (events.length > 0) {
          const detection = detectCrashArtifacts(events, session.messages);
          if (detection.crashed) {
            const interject = formatCrashInterject(detection.artifacts);
            d.interject(interject);

            // Audit record in event log
            const lastEvent = events[events.length - 1];
            const crashEvent = {
              id: generateEventId(),
              timestamp: Date.now(),
              sessionId: options.resume,
              turnId: lastEvent.turnId,
              type: 'crash_recovered' as const,
              artifactCount: detection.artifacts.length,
              orphanedTools: detection.artifacts.map((a) => ({
                toolUseId: a.toolUseId,
                name: a.name,
                input: a.input,
                startedAt: a.startedAt,
                startEventId: a.startEventId,
              })),
              interjected: true,
              crashedTurnId: lastEvent.turnId,
            };
            await d.eventLogStore.append(options.resume, crashEvent);

            d.emit(
              {
                type: 'crash_recovered',
                sessionId: options.resume,
                artifactCount: detection.artifacts.length,
                orphanedTools: crashEvent.orphanedTools,
                crashedTurnId: lastEvent.turnId,
              },
              options?.onEvent,
            );
          }
        }
      }
      return session;
    }
    if (options?.fork) {
      const source = await d.sessionStore.load(options.fork);
      if (!source) throw new Error(`Session not found: ${options.fork}`);
      return {
        ...structuredClone(source),
        id: generateId(),
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
    }
    return this.createFreshSession();
  }

  /** Build a fresh empty session and emit the session_start event log entry. */
  async createFreshSession(): Promise<Session> {
    const d = this.deps;
    const newSession: Session = {
      id: generateId(),
      messages: [],
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      metadata: createEmptySessionMetadata(),
    };

    // DURABILITY: write session_start event with complete initial state
    if (d.eventLogStore) {
      const projectContext = d.getProjectContext();
      const compactionConfig = d.getCompactionConfig();
      const projectCtx = projectContext
        ? await projectContext.loadContext().catch(() => undefined)
        : undefined;
      const providerConfig = d.getProviderConfig();
      await d.eventLogStore.append(newSession.id, {
        id: generateEventId(),
        timestamp: Date.now(),
        sessionId: newSession.id,
        turnId: 'start',
        type: 'session_start',
        systemPrompt: normalizeSystemPrompt(d.getSystemPrompt()),
        projectContextSnapshot: projectCtx,
        toolsAvailable: Array.from(d.getTools().values()).map((t) => t.definition.name),
        guardEnabled: d.toolGuardEnabled,
        providerType: providerConfig.type,
        model: providerConfig.model,
        compactionConfig: compactionConfig
          ? { ...compactionConfig, enabledLayers: compactionConfig.enabledLayers }
          : undefined,
      });
    }

    return newSession;
  }

  /** Public API: create and persist an empty session before the first query turn. */
  async createSession(_options?: CreateSessionOptions): Promise<Session> {
    const session = await this.createFreshSession();
    await this.deps.sessionStore.save(session);
    return session;
  }

  /** Load session — messages.json is authoritative. */
  async getSession(id: string): Promise<Session | null> {
    return await this.deps.sessionStore.load(id);
  }

  /** Enumerate all known session ids from the session store. */
  async listSessions(): Promise<string[]> {
    return this.deps.sessionStore.list();
  }

  /**
   * Clear all messages and event log for a session, resetting it to a blank
   * state while keeping the same session ID. This is what "clear chat"
   * should mean: the next query on this session starts fresh.
   */
  async clearSession(id: string): Promise<void> {
    const d = this.deps;
    // 1. Clear the event log so resolveSession won't rebuild old messages
    if (d.eventLogStore) await d.eventLogStore.clear(id);
    // 2. Save an empty session to the session store
    const existing = await d.sessionStore.load(id);
    const cleared: Session = {
      id,
      messages: [],
      createdAt: existing?.createdAt ?? Date.now(),
      lastAccessedAt: Date.now(),
      metadata: existing?.metadata ?? createEmptySessionMetadata(),
    };
    await d.sessionStore.save(cleared);
  }

  /** Permanently delete a session's provider context and event log. */
  async deleteSession(id: string): Promise<void> {
    await this.deps.sessionStore.delete(id);
    if (this.deps.eventLogStore) await this.deps.eventLogStore.clear(id);
  }

  /**
   * Hydrate a UI/session view from SDK-owned data. `events.jsonl` is used
   * when present so products can render full history without maintaining
   * their own message cache.
   */
  async getSessionView(
    id: string,
    options?: { agentId?: string; eventLimit?: number; fullHistory?: boolean },
  ): Promise<AgentSessionView | null> {
    const session = await this.getSession(id);
    if (!session) return null;
    const events = this.deps.eventLogStore
      ? await this.deps.eventLogStore.getEvents(id, options?.fullHistory
        ? { types: UI_EVENT_TYPES }
        : { tail: options?.eventLimit ?? SESSION_DETAIL_EVENT_LIMIT, types: UI_EVENT_TYPES })
      : undefined;
    return toAgentSessionView(session, { events, agentId: options?.agentId });
  }

  /** Append a host/runtime event into the SDK-owned session event log. */
  async appendSessionEvent(sessionId: string, draft: SessionEventDraft): Promise<SessionEvent | null> {
    if (!this.deps.eventLogStore) return null;
    const event = {
      ...draft,
      id: draft.id ?? generateEventId(),
      timestamp: draft.timestamp ?? Date.now(),
      sessionId,
    } as SessionEvent;
    await this.deps.eventLogStore.append(sessionId, event);
    return event;
  }

  /** List all sessions as hydrated SDK views, newest first. */
  async listSessionViews(
    options?: { agentId?: string; includeMessages?: boolean; eventLimit?: number },
  ): Promise<AgentSessionView[]> {
    const ids = new Set(await this.listSessions());
    if (this.deps.eventLogStore) {
      for (const id of await this.deps.eventLogStore.listSessions()) ids.add(id);
    }
    const views: AgentSessionView[] = [];
    for (const id of ids) {
      if (options?.includeMessages) {
        const view = await this.getSessionView(id, {
          agentId: options.agentId,
          eventLimit: options.eventLimit ?? SESSION_DETAIL_EVENT_LIMIT,
        });
        if (view) views.push(view);
        continue;
      }

      const summary = this.deps.sessionStore.loadSummary
        ? await this.deps.sessionStore.loadSummary(id)
        : await this.getSession(id);
      if (!summary) continue;
      const events = this.deps.eventLogStore
        ? await this.deps.eventLogStore.getEvents(id, {
          tail: options?.eventLimit ?? SESSION_LIST_EVENT_LIMIT,
          types: UI_EVENT_TYPES,
        })
        : undefined;
      views.push(toAgentSessionSummary(summary, { events, agentId: options?.agentId }));
    }
    return views.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** Todos for a session — empty array when none. */
  async getTodos(sessionId: string): Promise<TodoItem[]> {
    const session = await this.deps.sessionStore.load(sessionId);
    if (!session) return [];
    return session.metadata.todo?.items ?? [];
  }

  /**
   * Manually compact a session's message history. Hosts that enforce "1 agent
   * 1 session" use this as the equivalent of OpenClaw's `/new` — collapsing
   * old messages into a summary, keeping the session alive with a smaller
   * context window. Does NOT create a new session.
   */
  async compactSession(
    sessionId: string,
    options?: { reason?: string },
  ): Promise<CompactionResult> {
    return compactSessionMessages(this.deps, sessionId, options);
  }
}
