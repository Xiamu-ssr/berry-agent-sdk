// ============================================================
// Berry Agent SDK — Shared Constants
// ============================================================
// Single source of truth for all tunable values.
// Import from here — never hardcode these numbers elsewhere.

// ----- Provider / Retry -----

/** Max retry attempts for transient API errors (429, 5xx, timeouts). */
export const MAX_RETRIES = 10;

/** Initial delay (ms) for exponential backoff. */
export const BASE_DELAY_MS = 500;

/** Ceiling for exponential backoff (ms). */
export const MAX_BACKOFF_MS = 32_000;

/** SDK-level request timeout (ms) passed to provider clients. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Default max_tokens sent to the model when the user doesn't specify. */
export const DEFAULT_MAX_TOKENS = 16_384;

// ----- Agent Loop -----

/** Default max tool-calling iterations per query. */
export const DEFAULT_MAX_TURNS = 25;

// ----- Compaction -----

/** Default model context window size (tokens). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Compaction fires when estimated tokens exceed this fraction of contextWindow. */
export const DEFAULT_COMPACTION_RATIO = 0.85;

/** Max lines kept per tool result before head/tail truncation (Layer 2). */
export const TOOL_RESULT_MAX_LINES = 50;

/** Number of recent tool-use pairs to preserve during compaction (Layer 3). */
export const TOOL_PAIRS_KEEP_RECENT = 5;

/** Assistant message character threshold for trimming (Layer 6). */
export const TRIM_ASSISTANT_THRESHOLD = 3000;

/** Head characters kept when trimming assistant messages (Layer 6). */
export const TRIM_ASSISTANT_HEAD = 1500;

/** Tail characters kept when trimming assistant messages (Layer 6). */
export const TRIM_ASSISTANT_TAIL = 1000;

/** Min messages to keep when truncating oldest (Layer 7). */
export const TRUNCATE_OLDEST_MIN_KEEP = 6;

/** Fraction of messages to keep when truncating oldest (Layer 7). */
export const TRUNCATE_OLDEST_KEEP_RATIO = 0.3;

/** Min messages before summarize layer activates (Layer 5). */
export const SUMMARIZE_MIN_MESSAGES = 10;

/** Fraction of recent messages preserved by summarize layer (Layer 5). */
export const SUMMARIZE_RECENT_RATIO = 0.3;
