import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import {
  SystemPromptCacheMode,
  joinZodPath,
  zodIssueMessage,
  type SystemPromptBlock,
  type SystemPromptInput,
} from '@berry-agent/small-shared-core';
import {
  BUILTIN_PROMPT_PACKS,
  DEFAULT_PROMPT_PACK,
  DEFAULT_PROMPT_PACK_ID,
  builtinPromptPackIds,
  getBuiltinPromptPack,
  normalizeBuiltinPackId,
} from './builtins.js';

export { SystemPromptCacheMode };
export type { SystemPromptBlock, SystemPromptInput };
export {
  BUILTIN_PROMPT_PACKS,
  DEFAULT_PROMPT_PACK,
  DEFAULT_PROMPT_PACK_ID,
  builtinPromptPackIds,
  getBuiltinPromptPack,
};

export interface PromptPack {
  /** Stable machine id. Used by config, import/export, and UI selection. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short summary for product UIs. */
  description?: string;
  /** Bump when prompt semantics change so hosts can audit compacted sessions. */
  version: string;
  /** General runtime behavior. SDK workspace/project context is appended after this. */
  baseAgent: SystemPromptInput;
  /** System prompt for the summarizer model used during hard compaction. */
  compactSystem: SystemPromptInput;
  /** User prompt appended to the old conversation during summary compaction. */
  compactSummary: string;
  /** Prefix for the synthetic user message that carries compacted context forward. */
  handoffResumePrefix: string;
  /** Suffix for the synthetic user message that carries compacted context forward. */
  handoffResumeSuffix: string;
  /** Prompt used before hard compaction to save only durable memory. */
  memoryFlush: string;
}

export type PromptPackInput = 'default' | string | PromptPack;

export interface PromptPackDescriptor {
  id: string;
  name: string;
  description?: string;
  version: string;
  builtin: boolean;
  path?: string;
}

export interface PromptPackDirectoryOptions {
  /** Directory that contains the `packs/` folder. */
  directory?: string;
}

export interface PromptPackImportOptions extends PromptPackDirectoryOptions {
  overwrite?: boolean;
}

const SCHEMA_VERSION = 'berry.prompt-pack.dir.v1';
const PACKS_DIR = 'packs';
const MANIFEST_FILE = 'prompt-pack.json';

const DEFAULT_FILES = {
  baseAgent: 'base-agent.md',
  compactSystem: 'compact-system.md',
  compactSummary: 'compact-summary.md',
  handoffResumePrefix: 'handoff-resume-prefix.md',
  handoffResumeSuffix: 'handoff-resume-suffix.md',
  memoryFlush: 'memory-flush.md',
} as const;

const zNonBlankString = z.string().refine((value) => value.trim().length > 0, 'must be a non-empty string');
const zPromptPackFiles = z.object({
  baseAgent: z.string().optional(),
  compactSystem: z.string().optional(),
  compactSummary: z.string().optional(),
  handoffResumePrefix: z.string().optional(),
  handoffResumeSuffix: z.string().optional(),
  memoryFlush: z.string().optional(),
}).strict();
const zPromptPackManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: zNonBlankString,
  name: zNonBlankString,
  description: z.string().optional(),
  version: zNonBlankString,
  files: zPromptPackFiles.optional(),
}).strict();

type PromptPackManifest = z.infer<typeof zPromptPackManifest>;

export function resolvePromptPack(
  input?: PromptPackInput,
  options: PromptPackDirectoryOptions = {},
): PromptPack {
  if (isPromptPack(input)) return input;
  const id = normalizeBuiltinPackId(input);
  if (options.directory) {
    ensurePromptPackDirectory(options.directory);
    const fromDisk = readPromptPack(options.directory, id);
    if (fromDisk) return fromDisk;
  }
  const builtin = getBuiltinPromptPack(id);
  if (builtin) return builtin;
  throw new Error(`Unknown prompt pack "${id}"`);
}

export function ensurePromptPackDirectory(directory: string): void {
  const packsRoot = packsDir(directory);
  mkdirSync(packsRoot, { recursive: true });
  for (const pack of BUILTIN_PROMPT_PACKS) {
    writePromptPack(directory, pack, { overwrite: false });
  }
}

export function listPromptPacks(directory?: string): PromptPackDescriptor[] {
  const builtin = new Map(BUILTIN_PROMPT_PACKS.map((pack) => [pack.id, descriptorOf(pack, true)]));
  if (!directory) return [...builtin.values()];
  ensurePromptPackDirectory(directory);

  const descriptors = new Map(builtin);
  for (const name of readdirSync(packsDir(directory), { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const packDir = join(packsDir(directory), name.name);
    const manifestPath = join(packDir, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readManifest(manifestPath);
      descriptors.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        builtin: !!getBuiltinPromptPack(manifest.id),
        path: packDir,
      });
    } catch {
      // Ignore malformed pack folders during listing; explicit load will throw.
    }
  }
  return [...descriptors.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readPromptPack(directory: string, id: string): PromptPack | null {
  const packDir = promptPackPath(directory, normalizeBuiltinPackId(id));
  if (!existsSync(join(packDir, MANIFEST_FILE))) return null;
  return readPromptPackFromDirectory(packDir);
}

export function readPromptPackFromDirectory(packDirectory: string): PromptPack {
  const manifest = readManifest(join(packDirectory, MANIFEST_FILE));
  const files = { ...DEFAULT_FILES, ...(manifest.files ?? {}) };
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    baseAgent: stableBlock(readText(packDirectory, files.baseAgent)),
    compactSystem: stableBlock(readText(packDirectory, files.compactSystem)),
    compactSummary: readText(packDirectory, files.compactSummary),
    handoffResumePrefix: readText(packDirectory, files.handoffResumePrefix),
    handoffResumeSuffix: readText(packDirectory, files.handoffResumeSuffix),
    memoryFlush: readText(packDirectory, files.memoryFlush),
  };
}

export function writePromptPack(
  directory: string,
  pack: PromptPack,
  options: { overwrite?: boolean } = {},
): string {
  const packDir = promptPackPath(directory, pack.id);
  const manifestPath = join(packDir, MANIFEST_FILE);
  if (existsSync(manifestPath) && !options.overwrite) return packDir;

  mkdirSync(packDir, { recursive: true });
  const manifest: PromptPackManifest = {
    schemaVersion: SCHEMA_VERSION,
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    files: DEFAULT_FILES,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.baseAgent), `${systemPromptToMarkdown(pack.baseAgent).trim()}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.compactSystem), `${systemPromptToMarkdown(pack.compactSystem).trim()}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.compactSummary), `${pack.compactSummary.trim()}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.handoffResumePrefix), `${pack.handoffResumePrefix.trim()}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.handoffResumeSuffix), `${pack.handoffResumeSuffix.trim()}\n`, 'utf-8');
  writeFileSync(join(packDir, DEFAULT_FILES.memoryFlush), `${pack.memoryFlush.trim()}\n`, 'utf-8');
  return packDir;
}

export function exportPromptPack(
  packOrId: PromptPackInput,
  targetDirectory: string,
  options: PromptPackImportOptions = {},
): string {
  const pack = resolvePromptPack(packOrId, { directory: options.directory });
  return writePromptPack(targetDirectory, pack, { overwrite: options.overwrite ?? true });
}

export function importPromptPack(
  sourcePackDirectory: string,
  targetDirectory: string,
  options: { overwrite?: boolean } = {},
): PromptPack {
  const pack = readPromptPackFromDirectory(sourcePackDirectory);
  writePromptPack(targetDirectory, pack, options);
  return pack;
}

export function promptPackPath(directory: string, id: string): string {
  return join(packsDir(directory), safePackDirName(normalizeBuiltinPackId(id)));
}

export function packsDir(directory: string): string {
  return join(resolve(directory), PACKS_DIR);
}

function descriptorOf(pack: PromptPack, builtin: boolean): PromptPackDescriptor {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    builtin,
  };
}

function isPromptPack(input: PromptPackInput | undefined): input is PromptPack {
  return !!input && typeof input === 'object' && 'baseAgent' in input;
}

function stableBlock(text: string): SystemPromptBlock[] {
  return [{ cache: SystemPromptCacheMode.Stable, text }];
}

function readManifest(path: string): PromptPackManifest {
  try {
    return zPromptPackManifest.parse(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      throw new Error(`Invalid prompt pack manifest ${path}: ${joinZodPath('manifest', issue?.path ?? [])} ${zodIssueMessage(issue)}`);
    }
    throw error;
  }
}

function readText(packDirectory: string, file: string): string {
  return readFileSync(join(packDirectory, file), 'utf-8').trim();
}

function systemPromptToMarkdown(input: SystemPromptInput): string {
  return input.map((item) => item.text).join('\n\n');
}

function safePackDirName(id: string): string {
  const name = basename(id).replace(/[^a-zA-Z0-9._-]/g, '-');
  return name || DEFAULT_PROMPT_PACK_ID;
}

