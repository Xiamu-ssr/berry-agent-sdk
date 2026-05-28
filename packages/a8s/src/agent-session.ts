// ============================================================
// @berry-agent/a8s — AgentSession (data-plane handle)
// ============================================================
// AgentSession is the only handle products use to drive an agent after
// ControlPlane.createAgent(). It mirrors the ManagedAgentRuntime data-plane
// surface as fully async methods so:
//   - Today: in-process callers see the same semantics as direct runtime use
//   - M4: a remote AgentSession routes through HTTP/WS without the product
//     changing a single line.
//
// What's intentionally NOT on AgentSession:
//   - dispose(): owned by ControlPlane.deleteAgent()
//   - addHand / removeHand / hasHand: a Hand is a live in-process object,
//     not remote-transportable. Hosts that need post-creation hand mutation
//     should construct hands inside the agent factory (WorkerAgentSpec)
//   - setActiveSessionId: internal; callers express intent via
//     createSession / loadSessionView / send

import type {
  AgentSnapshot,
  AgentSessionView,
  AgentStatus,
  ContentBlock,
  ManagedAgentClearResult,
  ManagedAgentContextSize,
  ManagedAgentDeleteResult,
  ManagedAgentRuntime,
  ManagedAgentSendOptions,
  ManagedAgentTurnResult,
  ProviderPublicConfig,
  ReasoningEffort,
  SessionEvent,
  SessionEventDraft,
  SystemPromptInput,
  TodoItem,
} from '@berry-agent/core';

export interface AgentSessionStatus {
  status: AgentStatus;
  detail?: string;
}

export interface LoadSessionViewOptions {
  eventLimit?: number;
  activate?: boolean;
}

export interface ListSessionViewsOptions {
  includeMessages?: boolean;
  eventLimit?: number;
}

export interface AgentSession {
  readonly agentId: string;

  // ----- Messaging -----
  send(prompt: string | ContentBlock[], options?: ManagedAgentSendOptions): Promise<ManagedAgentTurnResult>;
  pause(reason?: string): Promise<boolean>;
  interject(text: string): Promise<void>;

  // ----- Sessions -----
  createSession(): Promise<AgentSessionView>;
  clearSession(sessionId?: string): Promise<ManagedAgentClearResult>;
  deleteSession(sessionId: string): Promise<ManagedAgentDeleteResult>;
  loadSessionView(sessionId: string, options?: LoadSessionViewOptions): Promise<AgentSessionView | null>;
  listSessionViews(options?: ListSessionViewsOptions): Promise<AgentSessionView[]>;
  appendSessionEvent(sessionId: string, draft: SessionEventDraft): Promise<SessionEvent | null>;
  getTodos(sessionId: string): Promise<TodoItem[]>;
  getActiveSessionId(): Promise<string | undefined>;

  // ----- Memory / instructions / project knowledge -----
  readMemory(): Promise<{ path: string; content: string }>;
  writeMemory(content: string): Promise<{ path: string; bytes: number }>;
  readInstructions(): Promise<{ path: string; content: string }>;
  writeInstructions(content: string): Promise<{ path: string; bytes: number }>;
  readProjectKnowledge(): Promise<{ project: string | null; files: Array<{ path: string; content: string }> }>;
  writeProjectKnowledge(content: string): Promise<{ project: string; path: string; bytes: number }>;

  // ----- Observability -----
  snapshot(): Promise<AgentSnapshot>;
  getStatus(): Promise<AgentSessionStatus>;
  contextSize(sessionId?: string): Promise<ManagedAgentContextSize>;
  currentProvider(): Promise<Readonly<ProviderPublicConfig>>;

  // ----- Runtime mutators -----
  switchModel(modelRef: string): Promise<void>;
  setSystemPrompt(blocks: SystemPromptInput): Promise<void>;
  setReasoningEffort(effort: ReasoningEffort): Promise<void>;
  setToolDenylist(names?: string[]): Promise<void>;
}

/**
 * In-process AgentSession — a thin async wrapper around a live
 * ManagedAgentRuntime. Intentionally has no behavior beyond delegation;
 * remote variants will replace each method with a transport call but keep
 * the same return shapes.
 */
export class InProcessAgentSession implements AgentSession {
  constructor(public readonly agentId: string, private readonly runtime: ManagedAgentRuntime) {}

  send(prompt: string | ContentBlock[], options?: ManagedAgentSendOptions): Promise<ManagedAgentTurnResult> {
    return this.runtime.send(prompt, options);
  }

  async pause(reason?: string): Promise<boolean> {
    return this.runtime.pause(reason);
  }

  async interject(text: string): Promise<void> {
    this.runtime.interject(text);
  }

  createSession(): Promise<AgentSessionView> {
    return this.runtime.createSession();
  }

  clearSession(sessionId?: string): Promise<ManagedAgentClearResult> {
    return this.runtime.clearSession(sessionId);
  }

  deleteSession(sessionId: string): Promise<ManagedAgentDeleteResult> {
    return this.runtime.deleteSession(sessionId);
  }

  loadSessionView(sessionId: string, options: LoadSessionViewOptions = {}): Promise<AgentSessionView | null> {
    return this.runtime.loadSessionView(sessionId, options);
  }

  listSessionViews(options: ListSessionViewsOptions = {}): Promise<AgentSessionView[]> {
    return this.runtime.listSessionViews(options);
  }

  appendSessionEvent(sessionId: string, draft: SessionEventDraft): Promise<SessionEvent | null> {
    return this.runtime.appendSessionEvent(sessionId, draft);
  }

  getTodos(sessionId: string): Promise<TodoItem[]> {
    return this.runtime.getTodos(sessionId);
  }

  async getActiveSessionId(): Promise<string | undefined> {
    return this.runtime.getActiveSessionId();
  }

  readMemory(): Promise<{ path: string; content: string }> {
    return this.runtime.readMemory();
  }

  writeMemory(content: string): Promise<{ path: string; bytes: number }> {
    return this.runtime.writeMemory(content);
  }

  readInstructions(): Promise<{ path: string; content: string }> {
    return this.runtime.readInstructions();
  }

  writeInstructions(content: string): Promise<{ path: string; bytes: number }> {
    return this.runtime.writeInstructions(content);
  }

  readProjectKnowledge(): Promise<{ project: string | null; files: Array<{ path: string; content: string }> }> {
    return this.runtime.readProjectKnowledge();
  }

  writeProjectKnowledge(content: string): Promise<{ project: string; path: string; bytes: number }> {
    return this.runtime.writeProjectKnowledge(content);
  }

  async snapshot(): Promise<AgentSnapshot> {
    return this.runtime.snapshot();
  }

  async getStatus(): Promise<AgentSessionStatus> {
    return this.runtime.getStatus();
  }

  contextSize(sessionId?: string): Promise<ManagedAgentContextSize> {
    return this.runtime.contextSize(sessionId);
  }

  async currentProvider(): Promise<Readonly<ProviderPublicConfig>> {
    return this.runtime.currentProvider;
  }

  async switchModel(modelRef: string): Promise<void> {
    this.runtime.switchModel(modelRef);
  }

  async setSystemPrompt(blocks: SystemPromptInput): Promise<void> {
    this.runtime.setSystemPrompt(blocks);
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    this.runtime.setReasoningEffort(effort);
  }

  async setToolDenylist(names: string[] = []): Promise<void> {
    this.runtime.setToolDenylist(names);
  }
}
