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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z, ZodError } from 'zod';
import { errorMessage, joinZodPath, zodIssueMessage } from '@berry-agent/small-shared-core';
import type { MCPTransportConfig } from './types.js';
import {
  DEFAULT_PLAYWRIGHT_MCP_BIN,
  DEFAULT_PLAYWRIGHT_MCP_PACKAGE,
  DEFAULT_PLAYWRIGHT_MCP_TEMPLATE,
} from './defaults.js';

/** Standard filename used by Claude Code / Cursor compatible MCP config layers. */
export const MCP_CONFIG_FILENAME = '.mcp.json' as const;

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

export type MCPPackageBinResolver = (
  packageName: string,
  binRelativePath: string,
) => string | null | undefined;

export interface MCPNpxPackageRewrite {
  /** Package argument inside `npx`, for example `@playwright/mcp`. */
  packageName: string;
  /** Package-relative JS entrypoint executed with the current Node binary. */
  binRelativePath: string;
}

export interface NormalizeMCPServerConfigOptions {
  /**
   * Resolve a package-relative bin path from the host package graph.
   * Hosts pass a resolver rooted at their own module URL when the package is
   * a product dependency instead of an SDK dependency.
   */
  resolvePackageBin?: MCPPackageBinResolver;
  /** Node executable used when rewriting `npx package` to `node package/bin`. */
  nodePath?: string;
  /** `npx` packages that should be rewritten to stable local JS entrypoints. */
  npxPackageRewrites?: MCPNpxPackageRewrite[];
}

export interface EnsureMCPConfigFileOptions {
  /** Raw `.mcp.json` template to write when the file is missing. */
  template?: unknown;
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

const zStringRecord = z.record(z.string());

/** Raw on-disk entry (Claude Code standard + berry extensions). */
const zRawMCPEntry = z.object({
  // stdio fields
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: zStringRecord.optional(),
  cwd: z.string().optional(),

  // sse / http fields
  type: z.string().optional(), // 'stdio' | 'sse' | 'http' | 'streamable_http' — case-insensitive
  url: z.string().optional(),
  headers: zStringRecord.optional(),

  // berry extensions
  shared: z.boolean().optional(),
  prefix: z.string().optional(),
  enabled: z.boolean().optional(),
});

type RawMCPEntry = z.infer<typeof zRawMCPEntry>;

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

/**
 * Ensure a `.mcp.json` file exists. Returns true when the file was created.
 * Products choose the target path; the SDK owns the file write mechanics and
 * built-in template shape.
 */
export function ensureMCPConfigFile(
  filePath: string,
  options: EnsureMCPConfigFileOptions = {},
): boolean {
  if (existsSync(filePath)) return false;
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, JSON.stringify(options.template ?? { mcpServers: {} }, null, 2) + '\n', 'utf-8');
  return true;
}

/** Ensure the SDK's default Playwright MCP template exists at `filePath`. */
export function ensureDefaultPlaywrightMCPConfig(filePath: string): boolean {
  return ensureMCPConfigFile(filePath, { template: DEFAULT_PLAYWRIGHT_MCP_TEMPLATE });
}

/** Normalize one resolved server config without changing cascade semantics. */
export function normalizeMCPServerConfig(
  entry: MCPServerConfig,
  options: NormalizeMCPServerConfigOptions = {},
): MCPServerConfig {
  if (entry.transport.type !== 'stdio') return entry;
  if (!isNpxCommand(entry.transport.command)) return entry;

  const rewrites = options.npxPackageRewrites ?? [];
  if (rewrites.length === 0 || !options.resolvePackageBin) return entry;

  const args = entry.transport.args ?? [];
  for (const rewrite of rewrites) {
    const packageIndex = args.findIndex((arg) => isNpxPackageArg(arg, rewrite.packageName));
    if (packageIndex < 0) continue;

    const cliPath = options.resolvePackageBin(rewrite.packageName, rewrite.binRelativePath);
    if (!cliPath) continue;

    return {
      ...entry,
      transport: {
        ...entry.transport,
        command: options.nodePath ?? process.execPath,
        args: [cliPath, ...args.slice(packageIndex + 1)],
      },
    };
  }

  return entry;
}

/** Normalize every server in a resolved MCP record. */
export function normalizeMCPConfigRecord(
  record: Record<string, MCPServerConfig>,
  options: NormalizeMCPServerConfigOptions = {},
): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(record)) {
    out[name] = normalizeMCPServerConfig(entry, options);
  }
  return out;
}

/** SDK default normalizer for built-in template packages such as Playwright MCP. */
export function normalizeDefaultMCPServerConfig(
  entry: MCPServerConfig,
  options: Omit<NormalizeMCPServerConfigOptions, 'npxPackageRewrites'> = {},
): MCPServerConfig {
  return normalizeMCPServerConfig(entry, {
    ...options,
    npxPackageRewrites: [{
      packageName: DEFAULT_PLAYWRIGHT_MCP_PACKAGE,
      binRelativePath: DEFAULT_PLAYWRIGHT_MCP_BIN,
    }],
  });
}

/** Create a resolver rooted at a host module URL, usually `import.meta.url`. */
export function createNodePackageBinResolver(baseUrl: string | URL): MCPPackageBinResolver {
  const require = createRequire(baseUrl);
  const cache = new Map<string, string | null>();

  return (packageName, binRelativePath) => {
    const key = `${packageName}/${binRelativePath}`;
    if (cache.has(key)) return cache.get(key);

    const resolved = resolveNodePackageBin(require.resolve.bind(require), packageName, binRelativePath);
    cache.set(key, resolved);
    return resolved;
  };
}

// ============================================================
// Internals
// ============================================================

function loadRawLayer(
  spec: MCPLayerSpec,
): Record<string, MergingMCPServerConfig> {
  const { filePath, label, sharedDefault = false } = spec;
  if (!existsSync(filePath)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`[MCP] Failed to parse ${filePath}:`, errorMessage(err));
    return {};
  }
  const servers = readRawMCPServers(raw, filePath);
  if (!servers) return {};

  const out: Record<string, MergingMCPServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    try {
      out[name] = normalizeEntry(name, readRawMCPEntry(name, entry), label, sharedDefault);
    } catch (err) {
      console.error(
        `[MCP] Skipping invalid server "${name}" in ${filePath}:`,
        errorMessage(err),
      );
    }
  }
  return out;
}

function readRawMCPServers(raw: unknown, filePath: string): Record<string, unknown> | null {
  if (!isPlainRecord(raw)) {
    console.error(`[MCP] Ignoring ${filePath}: root must be a JSON object`);
    return null;
  }
  if (raw.mcpServers === undefined) return null;
  if (!isPlainRecord(raw.mcpServers)) {
    console.error(`[MCP] Ignoring ${filePath}: "mcpServers" must be a JSON object`);
    return null;
  }
  return raw.mcpServers;
}

function readRawMCPEntry(serverName: string, raw: unknown): RawMCPEntry {
  if (!isPlainRecord(raw)) {
    throw new Error(`server "${serverName}" must be a JSON object`);
  }
  try {
    return zRawMCPEntry.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new Error(`server "${serverName}" ${formatIssuePath(issue?.path ?? [])}: ${zodIssueMessage(issue)}`);
    }
    throw error;
  }
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

function isNpxCommand(command: string): boolean {
  const executable = command.split(/[\\/]/).pop()?.toLowerCase();
  return executable === 'npx' || executable === 'npx.cmd';
}

function isNpxPackageArg(arg: string, packageName: string): boolean {
  return arg === packageName || arg.startsWith(`${packageName}@`);
}

function resolveNodePackageBin(
  resolveModule: (id: string) => string,
  packageName: string,
  binRelativePath: string,
): string | null {
  try {
    return resolveModule(`${packageName}/${binRelativePath}`);
  } catch {
    try {
      return join(dirname(resolveModule(`${packageName}/package.json`)), binRelativePath);
    } catch {
      return null;
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatIssuePath(path: Array<string | number>): string {
  if (path.length === 0) return 'entry';
  return joinZodPath('field', path);
}
