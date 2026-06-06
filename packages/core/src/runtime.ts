// ============================================================
// Berry Agent SDK — Managed Agent Runtime
// ============================================================
// A small harness facade around Agent that owns per-agent session lifecycle
// semantics. Host products can still choose roots, config, hands, and
// transport, but they should not reimplement create/load/send/delete chat
// lifecycle glue.

import { Agent } from './agent.js';
import type { AgentConfig } from './agent-config-types.js';
import type { InstallSkillInput } from './skills/installer.js';
import type {
  AgentEvent,
  AgentStatus,
  QueryResult,
} from './agent-runtime-types.js';
import type { ContentBlock } from './content-types.js';
import {
  createPendingUserChatMessage,
} from './chat.js';
import type {
  AgentChatMessage,
  AgentSessionView,
} from './chat-types.js';
import { currentContextTokens } from './compaction/runner.js';
import type { AgentSnapshot } from './agent-helpers/introspection.js';
import type { ProviderPublicConfig } from './provider-types.js';
import type { Hand, HandToolAdapterOptions } from './hands.js';
import type { EventLogListener, GetEventsOptions, SessionEvent, SessionEventDraft } from './event-log/types.js';
import type { ReasoningEffort } from './workspace/initializer.js';
import type { SystemPromptInput } from '@berry-agent/small-shared-core';
import type { TodoItem } from './session-types.js';

interface ManagedAgentRuntimeOptions {
  agent: Agent;
  /** Product-visible id used only when hydrating session views. */
  agentId?: string;
  disposeHooks?: Array<() => void | Promise<void>>;
}

export interface ManagedAgentRuntimeCreateOptions {
  config: AgentConfig;
  /** Product-visible id used only when hydrating session views. */
  agentId?: string;
  /** Runtime deny-list seeded after workspace metadata is loaded. */
  toolDenylist?: string[];
  disposeHooks?: Array<() => void | Promise<void>>;
}

export interface ManagedAgentSendOptions {
  sessionId?: string;
  requestId?: string;
  stream?: boolean;
  eventLimit?: number;
  onEvent?: (event: AgentEvent) => void;
  onUserMessagePersisted?: (message: AgentChatMessage, sessionId: string) => void;
}

export interface ManagedAgentTurnResult {
  sessionId: string;
  userMessage: AgentChatMessage;
  result: QueryResult;
  assistantMessage: AgentChatMessage;
  view: AgentSessionView | null;
}

export interface ManagedAgentClearResult {
  sessionId: string;
  view: AgentSessionView | null;
}

export interface ManagedAgentDeleteResult {
  sessionId: string;
  wasActive: boolean;
}

export interface ManagedAgentContextSize {
  current: number;
  window: number;
}

export class ManagedAgentRuntime {
  readonly agentId?: string;
  private readonly agent: Agent;
  private readonly disposeHooks: Array<() => void | Promise<void>>;

  private constructor(options: ManagedAgentRuntimeOptions) {
    this.agent = options.agent;
    this.agentId = options.agentId;
    this.disposeHooks = options.disposeHooks ?? [];
  }

  static create(options: ManagedAgentRuntimeCreateOptions): ManagedAgentRuntime {
    const agent = new Agent(options.config);
    if (options.toolDenylist) {
      agent.setToolDenylist(options.toolDenylist);
    }
    return new ManagedAgentRuntime({
      agent,
      agentId: options.agentId,
      disposeHooks: options.disposeHooks,
    });
  }

  getActiveSessionId(): string | undefined {
    return this.agent.lastSessionId;
  }

  setActiveSessionId(sessionId: string | undefined): void {
    this.agent.setLastSessionId(sessionId);
  }

  getStatus(): { status: AgentStatus; detail?: string } {
    return {
      status: this.agent.status,
      detail: this.agent.statusDetail,
    };
  }

  get isDisposed(): boolean {
    return this.agent.isDisposed;
  }

  get currentProvider(): Readonly<ProviderPublicConfig> {
    return this.agent.currentProvider;
  }

  switchModel(modelRef: string): void {
    this.agent.switchModel(modelRef);
  }

  snapshot(): AgentSnapshot {
    return this.agent.snapshot();
  }

  pause(reason = 'paused by host'): boolean {
    return this.agent.pause(reason);
  }

  interject(text: string): void {
    this.agent.interject(text);
  }

  async dispose(): Promise<void> {
    await this.agent.dispose();
    await Promise.all(this.disposeHooks.map(async (hook) => {
      try {
        await hook();
      } catch (err) {
        console.warn('[runtime] dispose hook threw:', err);
      }
    }));
  }

  setSystemPrompt(blocks: SystemPromptInput): void {
    this.agent.setSystemPrompt(blocks);
  }

  setReasoningEffort(effort: ReasoningEffort): void {
    this.agent.setReasoningEffort(effort);
  }

  setToolDenylist(names: string[] = []): void {
    this.agent.setToolDenylist(names);
  }

  /** Toggle built-in Hands (workspace/web) live + persist to agent.json. */
  setBuiltinHands(ids: string[]): Promise<void> {
    return this.agent.setBuiltinHands(ids);
  }

  /** Built-in Hand ids currently mounted. */
  getBuiltinHands(): string[] {
    return this.agent.getBuiltinHands();
  }

  hasHand(id: string): boolean {
    return this.agent.hasHand(id);
  }

  addHand(hand: Hand, options?: HandToolAdapterOptions): void {
    this.agent.addHand(hand, options);
  }

  removeHand(id: string): Promise<boolean> {
    return this.agent.removeHand(id);
  }

  /**
   * Snapshot every tool the agent currently exposes to the model —
   * builtin runtime tools, MCP-discovered tools, host-injected tools,
   * skill tools, and whatever hands have added. Cheap; useful for
   * tests + introspection. Mutations are not observed live.
   */
  getTools() {
    return this.agent.getTools();
  }

  async readMemory(): Promise<{ path: string; content: string }> {
    return this.agent.readMemory();
  }

  async writeMemory(content: string): Promise<{ path: string; bytes: number }> {
    return this.agent.writeMemory(content);
  }

  /** Install a skill into the agent's home; takes effect next turn. */
  async installSkill(input: InstallSkillInput): Promise<void> {
    return this.agent.installSkill(input);
  }

  /** Remove a skill from the agent's home. Returns whether it existed. */
  async removeSkill(name: string): Promise<boolean> {
    return this.agent.removeSkill(name);
  }

  /** Names of skills currently installed in the agent's home. */
  async listInstalledSkills(): Promise<string[]> {
    return this.agent.listInstalledSkills();
  }

  async readInstructions(): Promise<{ path: string; content: string }> {
    return this.agent.readInstructions();
  }

  async writeInstructions(content: string): Promise<{ path: string; bytes: number }> {
    return this.agent.writeInstructions(content);
  }

  async readProjectKnowledge(): Promise<{ project: string | null; files: Array<{ path: string; content: string }> }> {
    return this.agent.readProjectKnowledge();
  }

  async writeProjectKnowledge(content: string): Promise<{ project: string; path: string; bytes: number }> {
    return this.agent.writeProjectKnowledge(content);
  }

  async appendSessionEvent(sessionId: string, draft: SessionEventDraft): Promise<SessionEvent | null> {
    return this.agent.appendSessionEvent(sessionId, draft);
  }

  async getSessionEvents(
    sessionId: string,
    options?: GetEventsOptions,
  ): Promise<SessionEvent[]> {
    return this.agent.getSessionEvents(sessionId, options);
  }

  /** Live tail of every session event for this agent. See Agent.subscribeSessionEvents. */
  subscribeSessionEvents(listener: EventLogListener): () => void {
    return this.agent.subscribeSessionEvents(listener);
  }

  async getTodos(sessionId: string): Promise<TodoItem[]> {
    return this.agent.getTodos(sessionId);
  }

  async createSession(): Promise<AgentSessionView> {
    const session = await this.agent.createSession();
    this.setActiveSessionId(session.id);
    const view = await this.agent.getSessionView(session.id, { agentId: this.agentId });
    if (!view) throw new Error(`Session disappeared after create: ${session.id}`);
    return view;
  }

  async clearSession(sessionId = this.getActiveSessionId()): Promise<ManagedAgentClearResult> {
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      targetSessionId = (await this.agent.listSessions())[0];
    }

    if (targetSessionId) {
      await this.agent.clearSession(targetSessionId);
    } else {
      targetSessionId = (await this.agent.createSession()).id;
    }

    this.setActiveSessionId(targetSessionId);
    const view = await this.agent.getSessionView(targetSessionId, { agentId: this.agentId });
    return { sessionId: targetSessionId, view };
  }

  async loadSessionView(
    sessionId: string,
    options: { eventLimit?: number; activate?: boolean } = {},
  ): Promise<AgentSessionView | null> {
    const view = await this.agent.getSessionView(sessionId, {
      agentId: this.agentId,
      eventLimit: options.eventLimit,
    });
    if (view && options.activate !== false) this.setActiveSessionId(sessionId);
    return view;
  }

  async listSessionViews(options: { includeMessages?: boolean; eventLimit?: number } = {}): Promise<AgentSessionView[]> {
    return this.agent.listSessionViews({
      agentId: this.agentId,
      includeMessages: options.includeMessages,
      eventLimit: options.eventLimit,
    });
  }

  async deleteSession(sessionId: string): Promise<ManagedAgentDeleteResult> {
    const wasActive = this.getActiveSessionId() === sessionId;
    await this.agent.deleteSession(sessionId);
    if (wasActive) this.setActiveSessionId(undefined);
    return { sessionId, wasActive };
  }

  async contextSize(sessionId = this.getActiveSessionId()): Promise<ManagedAgentContextSize> {
    const window = this.agent.snapshot().compaction?.contextWindow ?? 0;
    if (!sessionId) return { current: 0, window };

    const session = await this.agent.getSession(sessionId);
    if (!session) return { current: 0, window };

    const current = currentContextTokens({
      session,
      systemPrompt: this.agent.getSystemPrompt(),
    });
    return { current, window };
  }

  async send(
    prompt: string | ContentBlock[],
    options: ManagedAgentSendOptions = {},
  ): Promise<ManagedAgentTurnResult> {
    let sessionId = options.sessionId ?? this.getActiveSessionId();

    if (sessionId) {
      const existing = await this.loadSessionView(sessionId, {
        eventLimit: options.eventLimit,
        activate: true,
      });
      if (!existing) throw new Error(`Session not found: ${sessionId}`);
    } else {
      sessionId = (await this.agent.createSession()).id;
      this.setActiveSessionId(sessionId);
    }

    const userMessage = createPendingUserChatMessage(prompt, {
      requestId: options.requestId,
    });
    options.onUserMessagePersisted?.(userMessage, sessionId);

    const result = await this.agent.send(prompt, {
      resume: sessionId,
      stream: options.stream ?? true,
      onEvent: options.onEvent,
    });

    this.setActiveSessionId(result.sessionId);
    const view = await this.agent.getSessionView(result.sessionId, {
      agentId: this.agentId,
      eventLimit: options.eventLimit,
    });
    const assistantMessage = lastAssistantMessage(view) ?? fallbackAssistantMessage(result, options.requestId);

    return {
      sessionId: result.sessionId,
      userMessage,
      result,
      assistantMessage,
      view,
    };
  }
}

function lastAssistantMessage(view: AgentSessionView | null): AgentChatMessage | undefined {
  return [...(view?.messages ?? [])].reverse().find((message) => message.role === 'assistant');
}

function fallbackAssistantMessage(result: QueryResult, requestId?: string): AgentChatMessage {
  return {
    id: `assistant_${Date.now()}`,
    role: 'assistant',
    content: result.text,
    timestamp: Date.now(),
    status: 'completed',
    delivery: 'turn',
    requestId,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  };
}
