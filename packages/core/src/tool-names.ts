// ============================================================
// Berry Agent SDK — Tool Name Constants
// ============================================================
// Single source of truth for all built-in tool names.
// Consumer code should reference these instead of hardcoding strings.

// ----- Core built-in tools -----

/** Skill loader tool (auto-registered when skillDirs configured). */
export const TOOL_LOAD_SKILL = 'load_skill' as const;

/** Delegate sub-task tool (auto-registered unless disabled). */
export const TOOL_DELEGATE = 'delegate' as const;

/** Spawn persistent sub-agent tool (auto-registered unless disabled). */
export const TOOL_SPAWN = 'spawn_agent' as const;

/** Memory search tool (auto-registered when memory search is available). */
export const TOOL_MEMORY_SEARCH = 'memory_search' as const;

/** Memory write tool (auto-registered when agent memory is available). */
export const TOOL_MEMORY_WRITE = 'memory_write' as const;

/** Per-session todo read tool (auto-registered). */
export const TOOL_TODO_READ = 'todo_read' as const;

/** Per-session todo write tool (auto-registered). */
export const TOOL_TODO_WRITE = 'todo_write' as const;

/** Sleep tool (auto-registered). Suspends the agent loop; interject() wakes early. */
export const TOOL_SLEEP = 'sleep' as const;

// ----- Common tools (@berry-agent/tools-common) -----

export const TOOL_READ_FILE = 'read_file' as const;
export const TOOL_WRITE_FILE = 'write_file' as const;
export const TOOL_EDIT_FILE = 'edit_file' as const;
export const TOOL_LIST_FILES = 'list_files' as const;
export const TOOL_SHELL = 'shell' as const;
export const TOOL_PROCESS_LIST = 'process_list' as const;
export const TOOL_PROCESS_POLL = 'process_poll' as const;
export const TOOL_PROCESS_LOG = 'process_log' as const;
export const TOOL_PROCESS_WRITE = 'process_write' as const;
export const TOOL_PROCESS_KILL = 'process_kill' as const;
export const TOOL_GREP = 'grep' as const;
export const TOOL_FIND_FILES = 'find_files' as const;
export const TOOL_WEB_SEARCH = 'web_search' as const;
export const TOOL_WEB_FETCH = 'web_fetch' as const;
export const TOOL_BROWSER = 'browser' as const;

/** All core built-in tool names. */
export const CORE_TOOL_NAMES = [
  TOOL_LOAD_SKILL,
  TOOL_DELEGATE,
  TOOL_SPAWN,
  TOOL_MEMORY_SEARCH,
  TOOL_MEMORY_WRITE,
  TOOL_TODO_READ,
  TOOL_TODO_WRITE,
  TOOL_SLEEP,
] as const;

/** All common tool names from @berry-agent/tools-common. */
export const COMMON_TOOL_NAMES = [
  TOOL_READ_FILE, TOOL_WRITE_FILE, TOOL_EDIT_FILE, TOOL_LIST_FILES,
  TOOL_SHELL, TOOL_PROCESS_LIST, TOOL_PROCESS_POLL, TOOL_PROCESS_LOG, TOOL_PROCESS_WRITE, TOOL_PROCESS_KILL,
  TOOL_GREP, TOOL_FIND_FILES,
  TOOL_WEB_SEARCH, TOOL_WEB_FETCH, TOOL_BROWSER,
] as const;
