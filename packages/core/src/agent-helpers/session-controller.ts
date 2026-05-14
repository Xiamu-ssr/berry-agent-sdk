// ============================================================
// SessionController — session lifecycle + crash recovery + manual compaction
// ============================================================
// Extracted from agent.ts to keep the god class thin. Owns the
// `crashCheckedSessions` per-process cache internally so Agent doesn't
// have to. Mutable Agent state (provider, providerConfig, systemPrompt,
// tools) is accessed through getter callbacks so the controller never
// holds stale refs after Agent.switchModel() / setSystemPrompt() /
// addTool().

import type {
  AgentConfig,
  AgentEvent,
  CreateSessionOptions,
  Provider,
  ProviderConfig,
  QueryOptions,
  Session,
  SessionStore,
  SystemPromptBlock,
  TodoItem,
  ToolRegistration,
} from '../types.js';
import { normalizeSystemPrompt } from '../types.js';
import type { CompactionStrategy } from '../compaction/types.js';
import type { CompactionResult } from '../compaction/compactor.js';
import type { EventLogStore, SessionEvent } from '../event-log/types.js';
import type { PromptPack } from '../prompts.js';
import { detectCrashArtifacts, formatCrashInterject } from '../event-log/crash-detector.js';
import { preCompactMemoryFlush, runCompaction } from '../compaction-runner.js';
import type { AgentMemory, ProjectContext } from '../workspace/types.js';
import {
  createEmptySessionMetadata,
  normalizeLoadedSession,
} from './session.js';
import { generateEventId, generateId } from './ids.js';

/**
 * Live-ref dependency bag. Fields that can be hot-reloaded on the Agent
 * (provider, providerConfig, systemPrompt, tools map) are exposed as getters
 * so the controller always reads the current value.
 */
export interface SessionControllerDeps {
  readonly sessionStore: SessionStore;
  readonly eventLogStore?: EventLogStore;
  readonly projectContext?: ProjectContext;
  readonly memory?: AgentMemory;
  readonly compactionConfig: AgentConfig['compaction'];
  readonly compactionStrategy?: CompactionStrategy;
  readonly toolGuardEnabled: boolean;

  /** Live reads of state that Agent may replace. */
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
      const session = normalizeLoadedSession(await d.sessionStore.load(options.resume));
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
      const source = normalizeLoadedSession(await d.sessionStore.load(options.fork));
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
      const projectCtx = d.projectContext
        ? await d.projectContext.loadContext().catch(() => undefined)
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
        compactionConfig: d.compactionConfig
          ? { ...d.compactionConfig, enabledLayers: d.compactionConfig.enabledLayers }
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
    return normalizeLoadedSession(await this.deps.sessionStore.load(id));
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
    const d = this.deps;
    const session = await d.sessionStore.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Manual compact always runs hard (user explicitly requested it)
    const compactLevel: 'hard' = 'hard';

    const fullSystemPrompt = await d.buildSystemPrompt(d.getSystemPrompt());
    const allowedTools = Array.from(d.getTools().values());
    const provider = d.getProvider();

    if (d.memory) {
      const makeBase = () => ({
        id: generateId(),
        timestamp: Date.now(),
        sessionId,
        turnId: 'compact',
      });
      await preCompactMemoryFlush({
        session,
        memory: d.memory,
        provider,
        systemPrompt: fullSystemPrompt,
        promptPack: d.getPromptPack(),
        emit: () => {},
        appendEvent: async (event: SessionEvent) => {
          if (d.eventLogStore) await d.eventLogStore.append(sessionId, event);
        },
        makeBase,
      });
    }

    const { result: compactResult } = await runCompaction({
      compactionStrategy: d.compactionStrategy,
      session,
      compactionConfig: d.compactionConfig,
      compactLevel,
      provider,
      systemPrompt: fullSystemPrompt,
      promptPack: d.getPromptPack(),
      allowedTools,
      emit: () => {},
      appendEvent: async (event: SessionEvent) => {
        if (d.eventLogStore) await d.eventLogStore.append(sessionId, event);
      },
      makeBase: () => ({
        id: generateId(),
        timestamp: Date.now(),
        sessionId,
        turnId: 'compact',
      }),
    });

    await d.sessionStore.save(session);

    if (d.eventLogStore) {
      const snapshot: SessionEvent = {
        id: generateId(),
        timestamp: Date.now(),
        sessionId,
        turnId: 'compact',
        type: 'messages_snapshot',
        messages: session.messages,
        reason: options?.reason ?? 'manual_compact',
      } as SessionEvent;
      await d.eventLogStore.append(sessionId, snapshot);
    }

    return compactResult;
  }
}
