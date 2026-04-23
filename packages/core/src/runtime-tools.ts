// ============================================================
// Berry Agent SDK — Runtime Tool Helpers
// ============================================================

import type {
  Session,
  SessionTodoState,
  TodoItem,
  ToolDefinition,
  ToolRegistration,
} from './types.js';
import type { AgentMemory, ProjectContext } from './workspace/types.js';
import {
  TOOL_TODO_READ,
  TOOL_TODO_WRITE,
  TOOL_SLEEP,
  TOOL_SAVE_MEMORY,
  TOOL_SAVE_DISCOVERY,
} from './tool-names.js';

/** Hard upper bound on a single sleep call, to stop agents sleeping forever. */
export const SLEEP_MAX_SECONDS = 300; // 5 minutes

/**
 * Signal object the agent loop passes to the sleep tool so that interject()
 * can wake the agent early. The agent sets `wake` to a resolved promise when
 * it wants to break sleeps in progress.
 */
export interface SleepSignal {
  /** Called by the sleep tool when it begins waiting. */
  onEnter: () => void;
  /** Called by the sleep tool when it exits (either timer fired or interject). */
  onExit: () => void;
  /** Promise that resolves early when interject() is called. */
  interjectWaker: () => Promise<void>;
}

interface RuntimeToolOptions {
  session?: Session;
  /**
   * Optional hook invoked after todo state changes (via todo_write).
   * Agent wires this up to emit `todo_updated` events.
   */
  onTodoChange?: (session: Session, state: SessionTodoState) => void;
  /**
   * Sleep signal provided by the agent loop. When set, the sleep tool is
   * registered and can be interrupted by interject().
   */
  sleepSignal?: SleepSignal;
  /**
   * Agent's personal memory (writes go to `{workspace}/MEMORY.md`).
   * When set, the `save_memory` tool is registered.
   */
  memory?: AgentMemory;
  /**
   * Project-shared context (writes go to `{project}/.berry-discoveries.md`).
   * When set, the `save_discovery` tool is registered so the agent can
   * deliberately persist knowledge visible to every teammate.
   */
  projectContext?: ProjectContext;
}

const TODO_READ_DEFINITION: ToolDefinition = {
  name: TOOL_TODO_READ,
  description: 'Read the current per-session todo checklist.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const TODO_WRITE_DEFINITION: ToolDefinition = {
  name: TOOL_TODO_WRITE,
  description: 'Replace the current per-session todo checklist with a minimal set of items.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Checklist item text' },
            done: { type: 'boolean', description: 'Whether the item is already completed' },
          },
          required: ['text'],
        },
        description: 'Checklist items to persist for this session',
      },
    },
    required: ['items'],
  },
};

const SLEEP_DEFINITION: ToolDefinition = {
  name: TOOL_SLEEP,
  description:
    `Suspend yourself for up to ${SLEEP_MAX_SECONDS}s. Use this to wait for background jobs, rate-limit windows, or to poll external state on an interval. The sleep can be cut short by an external interject signal — you'll resume and continue reasoning immediately when that happens.`,
  inputSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: `How long to sleep, in seconds. Clamped to [0, ${SLEEP_MAX_SECONDS}].`,
      },
    },
    required: ['seconds'],
  },
};

const SAVE_MEMORY_DEFINITION: ToolDefinition = {
  name: TOOL_SAVE_MEMORY,
  description:
    'Append an entry to your personal MEMORY.md. Use this to save ' +
    'decisions, preferences, context, or lessons that you want to recall in ' +
    'future sessions. Private to you — teammates cannot read it. Keep ' +
    'entries concise and self-contained (no dangling references to "above").',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown to append.' },
    },
    required: ['content'],
  },
};

const SAVE_DISCOVERY_DEFINITION: ToolDefinition = {
  name: TOOL_SAVE_DISCOVERY,
  description:
    'Append a discovery to the shared project knowledge base ' +
    '(`.berry-discoveries.md` in the project root). Use this to record ' +
    'findings, conventions, gotchas, or context that EVERY teammate on ' +
    'this project will benefit from reading. Keep each discovery focused ' +
    'and evergreen — transient task state belongs on the worklist instead.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown to append.' },
    },
    required: ['content'],
  },
};

export function getRuntimeToolDefinitions(options: Omit<RuntimeToolOptions, 'session'>): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  definitions.push(TODO_READ_DEFINITION, TODO_WRITE_DEFINITION);
  if (options.sleepSignal) definitions.push(SLEEP_DEFINITION);
  if (options.memory) definitions.push(SAVE_MEMORY_DEFINITION);
  if (options.projectContext) definitions.push(SAVE_DISCOVERY_DEFINITION);
  return definitions;
}

export function createRuntimeTools(options: RuntimeToolOptions): ToolRegistration[] {
  const tools: ToolRegistration[] = [];

  tools.push({
    definition: TODO_READ_DEFINITION,
    execute: async () => ({
      content: JSON.stringify(formatTodoState(options.session?.metadata.todo), null, 2),
    }),
  });

  tools.push({
    definition: TODO_WRITE_DEFINITION,
    execute: async (input) => {
      if (!options.session) {
        return { content: 'Error: todo tools require an active session', isError: true };
      }

      const items = parseTodoItems(input.items);
      if (!items) {
        return { content: 'Error: items must be an array of todo objects', isError: true };
      }

      const newState: SessionTodoState = {
        items,
        updatedAt: Date.now(),
      };
      options.session.metadata.todo = newState;
      try {
        options.onTodoChange?.(options.session, newState);
      } catch {
        // never let listener failures break tool execution
      }

      return {
        content: JSON.stringify(formatTodoState(newState), null, 2),
      };
    },
  });

  if (options.memory) {
    const mem = options.memory;
    tools.push({
      definition: SAVE_MEMORY_DEFINITION,
      execute: async (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : '';
        if (!content) {
          return { content: 'Error: content must be a non-empty string', isError: true };
        }
        try {
          await mem.append(content);
          return { content: `Saved ${content.length} chars to MEMORY.md` };
        } catch (err) {
          return { content: `Error saving to memory: ${(err as Error).message}`, isError: true };
        }
      },
    });
  }

  if (options.projectContext) {
    const pc = options.projectContext;
    tools.push({
      definition: SAVE_DISCOVERY_DEFINITION,
      execute: async (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : '';
        if (!content) {
          return { content: 'Error: content must be a non-empty string', isError: true };
        }
        try {
          await pc.appendDiscovery(content);
          return { content: `Saved ${content.length} chars to .berry-discoveries.md (visible to every teammate on this project)` };
        } catch (err) {
          return { content: `Error saving discovery: ${(err as Error).message}`, isError: true };
        }
      },
    });
  }

  if (options.sleepSignal) {
    const sig = options.sleepSignal;
    tools.push({
      definition: SLEEP_DEFINITION,
      execute: async (input) => {
        const raw = typeof input.seconds === 'number' ? input.seconds : NaN;
        if (!Number.isFinite(raw) || raw < 0) {
          return { content: 'Error: seconds must be a non-negative number', isError: true };
        }
        const seconds = Math.min(raw, SLEEP_MAX_SECONDS);
        sig.onEnter();
        const started = Date.now();
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timerPromise = new Promise<'timer'>((resolve) => {
            timer = setTimeout(() => resolve('timer'), seconds * 1000);
          });
          const interjectPromise = sig.interjectWaker().then(() => 'interject' as const);
          const outcome = await Promise.race([timerPromise, interjectPromise]);
          if (timer) clearTimeout(timer);
          const elapsed = ((Date.now() - started) / 1000).toFixed(2);
          return {
            content: outcome === 'interject'
              ? `Slept ${elapsed}s of ${seconds}s (woken early by interject)`
              : `Slept ${elapsed}s`,
          };
        } finally {
          sig.onExit();
        }
      },
    });
  }

  return tools;
}

// ===== Internal Helpers =====

function parseTodoItems(input: unknown): TodoItem[] | null {
  if (!Array.isArray(input)) return null;

  const items: TodoItem[] = [];
  for (const rawItem of input) {
    if (!isRecord(rawItem)) return null;

    const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
    if (!text) return null;

    items.push({
      text,
      done: rawItem.done === true,
    });
  }

  return items;
}

function formatTodoState(state?: SessionTodoState): SessionTodoState {
  return {
    items: state?.items ?? [],
    updatedAt: state?.updatedAt ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
