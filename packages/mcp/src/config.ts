// ============================================================
// Berry Agent SDK — MCP Configuration Cascade Loader
// ============================================================
// Generic N-layer loader for `.mcp.json` files that follow the
// Claude Code / Cursor standard schema (flat `mcpServers` map).
//
// SDK owns the mechanics: file parsing, transport inference,
// field-level deep merge, three-state `shared` / `prefix`.
// Products own the semantics: which file paths map to which
// layer labels, what the "shared by default" policy is per
// label.
//
// On-disk extensions (`shared`, `prefix`, `enabled`) are opt-in;
// a vanilla Claude Code config parses without edits.

import { readFileSync, existsSync } from 'node:fs';
import type { MCPTransportConfig } from './types.js';

// ============================================================
// Public types
// ============================================================

/**
 * Resolved MCP server entry consumed by MCPManager / MCPCenter.
 * `layer` is a free-form label chosen by the caller; the SDK never
 * inspects the string, only propagates the top-most contributing
 * label for UI attribution.
 */
export interface MCPServerConfig {
  /** Transport configuration (stdio or http/sse). */
  transport: MCPTransportConfig;
  /** true = shared across agents, false = per-agent instance. */
  shared: boolean;
  /**
   * Prefix added to every tool name from this server.
   *  - `undefined` → auto-detect at connect time: apply `${serverName}_`
   *    unless the server already baked that identifier into its tool names
   *    (avoids `skylark_skylark_*` double-prefixing).
   *  - `""` → user explicitly opted out; no prefix ever applied.
   *  - any other string → exactly that prefix, verbatim.
   */
  prefix: string | undefined;
  /** Whether this server is enabled (defaults to true). */
  enabled: boolean;
  /**
   * Top-most layer label whose entry contributed to the final merged config.
   * Whichever layer most recently overwrote the name wins.
   */
  layer: string;
}

/** One layer in the cascade. */
export interface MCPLayerSpec {
  /** Absolute path to the `.mcp.json` file. Missing files are treated as empty. */
  filePath: string;
  /** Free-form label propagated into `MCPServerConfig.layer`. */
  label: string;
  /**
   * Default value for `shared` when no layer in the cascade declared it.
   * Defaults to `false`. Product code can pass `true` for layers whose
   * entries should be shared across agents unless opted out.
   */
  sharedDefault?: boolean;
}

export interface LoadMergedMCPConfigOptions {
  /** Layers in application order; later layers win on conflict. */
  layers: MCPLayerSpec[];
}

// ============================================================
// Internal shapes
// ============================================================

/**
 * Intermediate representation used during merge. `shared` is optional
 * here so we can distinguish "user didn't write shared" from "user wrote
 * false". After merge, `resolveDefaults` collapses undefined → layer default.
 */
interface MergingMCPServerConfig {
  transport: MCPTransportConfig;
  shared?: boolean;
  prefix: string | undefined;
  enabled: boolean;
  layer: string;
  /**
   * `sharedDefault` of the top-most contributing layer — used when
   * resolving `shared` to a concrete boolean.
   */
  sharedDefaultForLayer: boolean;
}

/** Raw on-disk entry (Claude Code standard + berry extensions). */
interface RawMCPEntry {
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  // sse / http fields
  type?: string; // 'stdio' | 'sse' | 'http' | 'streamable_http' — case-insensitive
  url?: string;
  headers?: Record<string, string>;

  // berry extensions
  shared?: boolean;
  prefix?: string;
  enabled?: boolean;
}

interface RawMCPJson {
  mcpServers?: Record<string, RawMCPEntry>;
}

// ============================================================
// Public API
// ============================================================

/**
 * Load one layer of MCP config from disk. Returns an empty map when the
 * file is missing. The single-layer shortcut is useful for UIs that show
 * per-layer contents separately.
 */
export function loadMCPLayer(
  filePath: string,
  layer: string,
  sharedDefault = false,
): Record<string, MCPServerConfig> {
  return resolveDefaults(loadRawLayer({ filePath, label: layer, sharedDefault }));
}

/**
 * Load and merge N layers of MCP configs. Layers are applied in order and
 * later layers win field-by-field. The `shared` default is applied *after*
 * the merge, based on whichever layer actually contributed the entry —
 * this preserves user intent when a layer sets `shared=true` and a lower
 * layer only tweaks `env`.
 */
export function loadMergedMCPConfig(
  opts: LoadMergedMCPConfigOptions,
): Record<string, MCPServerConfig> {
  const rawLayers = opts.layers.map(loadRawLayer);
  return resolveDefaults(mergeRawLayers(rawLayers));
}

/**
 * Field-level deep merge of pre-resolved {@link MCPServerConfig} layers.
 * Useful when callers have already loaded layers separately (e.g. for
 * an in-memory override). The three-state `shared`/`prefix` merge is
 * preserved.
 */
export function mergeMCPConfigs(
  layers: Array<Record<string, MCPServerConfig>>,
): Record<string, MCPServerConfig> {
  const merging = layers.map(stripDefaults);
  return resolveDefaults(mergeRawLayers(merging));
}

// ============================================================
// Internals
// ============================================================

function loadRawLayer(
  spec: MCPLayerSpec,
): Record<string, MergingMCPServerConfig> {
  const { filePath, label, sharedDefault = false } = spec;
  if (!existsSync(filePath)) return {};
  let raw: RawMCPJson;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8')) as RawMCPJson;
  } catch (err) {
    console.error(`[MCP] Failed to parse ${filePath}:`, err instanceof Error ? err.message : err);
    return {};
  }
  if (!raw.mcpServers || typeof raw.mcpServers !== 'object') return {};

  const out: Record<string, MergingMCPServerConfig> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    try {
      out[name] = normalizeEntry(name, entry, label, sharedDefault);
    } catch (err) {
      console.error(
        `[MCP] Skipping invalid server "${name}" in ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

function stripDefaults(
  layer: Record<string, MCPServerConfig>,
): Record<string, MergingMCPServerConfig> {
  const out: Record<string, MergingMCPServerConfig> = {};
  for (const [name, entry] of Object.entries(layer)) {
    // Treat a resolved `shared` as a user-declared value — callers passing
    // in already-resolved layers have made an explicit choice per entry.
    out[name] = {
      transport: entry.transport,
      shared: entry.shared,
      prefix: entry.prefix,
      enabled: entry.enabled,
      layer: entry.layer,
      sharedDefaultForLayer: entry.shared,
    };
  }
  return out;
}

function mergeRawLayers(
  layers: Array<Record<string, MergingMCPServerConfig>>,
): Record<string, MergingMCPServerConfig> {
  const out: Record<string, MergingMCPServerConfig> = {};
  for (const layer of layers) {
    for (const [name, incoming] of Object.entries(layer)) {
      const existing = out[name];
      if (!existing) {
        out[name] = structuredClone(incoming);
      } else {
        out[name] = mergeOne(existing, incoming);
      }
    }
  }
  return out;
}

function resolveDefaults(
  merging: Record<string, MergingMCPServerConfig>,
): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(merging)) {
    out[name] = {
      transport: entry.transport,
      shared: entry.shared ?? entry.sharedDefaultForLayer,
      prefix: entry.prefix,
      enabled: entry.enabled,
      layer: entry.layer,
    };
  }
  return out;
}

function normalizeEntry(
  serverName: string,
  entry: RawMCPEntry,
  layer: string,
  sharedDefault: boolean,
): MergingMCPServerConfig {
  const transport = inferTransport(serverName, entry);
  return {
    transport,
    // Three-state: preserve user intent. The layer default is applied only
    // after all layers merge, in resolveDefaults — so a lower layer's
    // explicit `shared=true` is not clobbered by an upper layer's default.
    shared: typeof entry.shared === 'boolean' ? entry.shared : undefined,
    prefix: entry.prefix,
    enabled: entry.enabled ?? true,
    layer,
    sharedDefaultForLayer: sharedDefault,
  };
}

function inferTransport(serverName: string, entry: RawMCPEntry): MCPTransportConfig {
  const type = entry.type?.toLowerCase();

  if (type === 'http' || type === 'streamable_http' || type === 'sse') {
    if (!entry.url) {
      throw new Error(`server "${serverName}" with type="${entry.type}" requires "url"`);
    }
    if (type === 'sse') {
      console.warn(`[MCP] server "${serverName}" requested SSE transport; SDK support pending, falling back to http.`);
    }
    return {
      type: 'http',
      url: entry.url,
      headers: entry.headers,
    };
  }

  if (type === 'stdio' || (!type && entry.command)) {
    if (!entry.command) {
      throw new Error(`server "${serverName}" with stdio transport requires "command"`);
    }
    return {
      type: 'stdio',
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
    };
  }

  throw new Error(
    `server "${serverName}": cannot infer transport (need either "command" for stdio or "type" + "url" for http/sse)`,
  );
}

function mergeOne(
  base: MergingMCPServerConfig,
  over: MergingMCPServerConfig,
): MergingMCPServerConfig {
  return {
    transport: mergeTransport(base.transport, over.transport),
    // Three-state: a later layer that didn't declare `shared` keeps whatever
    // the base had. Without this, upper layers would silently wipe a lower
    // layer's explicit shared=true via their own default.
    shared: over.shared ?? base.shared,
    // Three-state prefix: undefined in a higher layer means "inherit",
    // while explicit "" means "user opted out of a prefix".
    prefix: over.prefix !== undefined ? over.prefix : base.prefix,
    enabled: over.enabled,
    // Attribute to whichever layer last contributed.
    layer: over.layer,
    sharedDefaultForLayer: over.sharedDefaultForLayer,
  };
}

function mergeTransport(
  base: MCPTransportConfig,
  over: MCPTransportConfig,
): MCPTransportConfig {
  if (base.type !== over.type) return structuredClone(over);

  if (base.type === 'stdio' && over.type === 'stdio') {
    return {
      type: 'stdio',
      command: over.command ?? base.command,
      args: over.args ?? base.args,
      env: mergeRecords(base.env, over.env),
      cwd: over.cwd ?? base.cwd,
    };
  }

  if (base.type === 'http' && over.type === 'http') {
    return {
      type: 'http',
      url: over.url ?? base.url,
      headers: mergeRecords(base.headers, over.headers),
    };
  }

  return structuredClone(over);
}

function mergeRecords(
  base: Record<string, string> | undefined,
  over: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !over) return undefined;
  return { ...(base ?? {}), ...(over ?? {}) };
}
