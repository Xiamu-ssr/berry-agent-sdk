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
import type {
  AgentMemory,
  MemorySearchProvider,
  MemorySearchResult,
} from './workspace/types.js';
import {
  TOOL_MEMORY_SEARCH,
  TOOL_MEMORY_WRITE,
  TOOL_SLEEP,
  TOOL_TODO_READ,
  TOOL_TODO_WRITE,
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
  memory?: AgentMemory;
  memorySearch?: MemorySearchProvider;
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
}

const MEMORY_SEARCH_DEFINITION: ToolDefinition = {
  name: TOOL_MEMORY_SEARCH,
  description: 'Search agent memory for relevant notes or previous decisions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for memory lookup' },
      limit: { type: 'number', description: 'Maximum number of matches to return (default: 5)' },
    },
    required: ['query'],
  },
};

const MEMORY_WRITE_DEFINITION: ToolDefinition = {
  name: TOOL_MEMORY_WRITE,
  description: 'Write to agent memory. Appends by default; set append=false to replace the full memory.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Memory content to store' },
      append: { type: 'boolean', description: 'Append instead of replacing the full memory (default: true)' },
    },
    required: ['content'],
  },
};

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

export function getRuntimeToolDefinitions(options: Omit<RuntimeToolOptions, 'session'>): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];

  if (options.memory || options.memorySearch) {
    definitions.push(MEMORY_SEARCH_DEFINITION);
  }

  if (options.memory) {
    definitions.push(MEMORY_WRITE_DEFINITION);
  }

  definitions.push(TODO_READ_DEFINITION, TODO_WRITE_DEFINITION);
  if (options.sleepSignal) definitions.push(SLEEP_DEFINITION);
  return definitions;
}

export function createRuntimeTools(options: RuntimeToolOptions): ToolRegistration[] {
  const tools: ToolRegistration[] = [];

  if (options.memory || options.memorySearch) {
    tools.push({
      definition: MEMORY_SEARCH_DEFINITION,
      execute: async (input) => {
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query) {
          return { content: 'Error: query must be a non-empty string', isError: true };
        }

        const limit = normalizeLimit(input.limit);
        const matches = await searchMemory(options, query, limit);
        return {
          content: JSON.stringify({ query, matches }, null, 2),
        };
      },
    });
  }

  if (options.memory) {
    tools.push({
      definition: MEMORY_WRITE_DEFINITION,
      execute: async (input) => {
        const content = typeof input.content === 'string' ? input.content : '';
        if (!content.trim()) {
          return { content: 'Error: content must be a non-empty string', isError: true };
        }

        const append = input.append !== false;
        if (append) {
          await options.memory!.append(content);
        } else {
          await options.memory!.write(content);
        }

        return {
          content: append
            ? `Appended ${content.length} chars to memory`
            : `Replaced memory with ${content.length} chars`,
        };
      },
    });
  }

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

async function searchMemory(
  options: RuntimeToolOptions,
  query: string,
  limit: number,
): Promise<MemorySearchResult[]> {
  if (options.memorySearch) {
    const results = await options.memorySearch.search(query, { limit });
    return normalizeMemoryResults(results, limit);
  }

  const searchFromMemory = getMemorySearchProvider(options.memory);
  if (searchFromMemory) {
    const results = await searchFromMemory.search(query, { limit });
    return normalizeMemoryResults(results, limit);
  }

  const content = options.memory ? await options.memory.load() : '';
  return fallbackSearch(content, query, limit);
}

function getMemorySearchProvider(memory?: AgentMemory): MemorySearchProvider | undefined {
  if (!memory) return undefined;
  const candidate = memory as AgentMemory & Partial<MemorySearchProvider>;
  return typeof candidate.search === 'function' ? candidate as MemorySearchProvider : undefined;
}

function normalizeMemoryResults(results: MemorySearchResult[], limit: number): MemorySearchResult[] {
  return results.slice(0, limit).map((result) => ({
    id: result.id,
    content: result.content,
    score: result.score,
    metadata: result.metadata,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  }));
}

function fallbackSearch(content: string, query: string, limit: number): MemorySearchResult[] {
  const normalizedQuery = query.toLowerCase();
  const sections = splitMemorySections(content);

  return sections
    .map((section) => {
      const score = countMatches(section.content.toLowerCase(), normalizedQuery);
      if (score === 0) return null;
      return { ...section, score };
    })
    .filter((section): section is MemorySearchResult & { score: number } => section !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    })
    .slice(0, limit);
}

function splitMemorySections(content: string): MemorySearchResult[] {
  const body = content.replace(/^# Agent Memory\s*/m, '').trim();
  if (!body) return [];

  const sections = body.includes('\n## ')
    ? body.split(/\n(?=## )/g)
    : [body];

  const results: MemorySearchResult[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const [, timestamp] = /^##\s+([^\n]+)\n?/.exec(trimmed) ?? [];
    const createdAt = timestamp ? Date.parse(timestamp) : Number.NaN;
    const result: MemorySearchResult = { content: trimmed };

    if (!Number.isNaN(createdAt)) {
      result.createdAt = createdAt;
    }

    results.push(result);
  }

  return results;
}

function countMatches(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;

  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count++;
    index = next + needle.length;
  }

  return count;
}

function normalizeLimit(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 5;
  return Math.max(1, Math.trunc(input));
}

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
