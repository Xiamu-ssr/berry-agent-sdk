import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  SystemPromptCacheMode,
  type SystemPromptBlock,
  type SystemPromptInput,
} from '@berry-agent/small-shared-core';

export { SystemPromptCacheMode };
export type { SystemPromptBlock, SystemPromptInput };

export interface PromptPack {
  /** Stable machine id. Used by config, import/export, and UI selection. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Short summary for product UIs. */
  description?: string;
  /** Bump when prompt semantics change so hosts can audit compacted sessions. */
  version: string;
  /** General runtime behavior. Product/project AGENTS.md is appended after this. */
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

type PromptPackManifest = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  version: string;
  files?: Partial<typeof DEFAULT_FILES>;
};

const SHARED_COMPACT_SUMMARY = `重要: 只输出文本,不要调用工具。

请把上方旧会话前缀压缩成一份可继续执行的结构化上下文工件。

要求:
- 保留用户真实意图、硬约束、偏好、最新拍板和不可重复踩坑的结论。
- 保留当前任务状态: 已完成、进行中、被阻塞、下一步。
- 保留工程事实: 文件路径、命令、错误、测试结果、API、数据格式、schema、行为决策。
- 保留工具/操作时序,粒度是“动作 -> 结果 -> 影响”,不要粘贴原始长输出。
- 区分“长期记忆候选”和“本 session 恢复信息”。不要声称自己已经写入记忆。
- 不要猜测。无法确认的内容标为 unknown 或 uncertain。
- 简洁优先,使用结构化条目。

严格输出以下形状:

<analysis>
检查摘要是否覆盖: 用户意图、当前状态、操作时序、文件、错误、决策、下一步。
</analysis>
<summary>
schema_version: berry.compact.v1
prompt_pack_version: {{prompt_pack_version}}

user_intent:
- ...

current_task:
- ...

conversation_state:
- ...

decisions:
- ...

files_and_artifacts:
- path: ...
  status: read|edited|created|deleted|unknown
  notes: ...

tool_ledger:
- order: 1
  action: ...
  result: ...
  consequence: ...

errors_and_recovery:
- ...

durable_memory_candidates:
- ...

open_questions:
- ...

next_step:
- ...
</summary>`;

const SHARED_MEMORY_FLUSH = `在 hard compact 之前,只提取跨 session 仍然有价值的长期记忆。

只保存:
- 用户稳定偏好,且未来会影响行为。
- 项目长期事实、路径、约定、架构决策。
- 用户明确建立的长期约束。

不要保存:
- 当前任务临时进度。
- 只用于恢复本 session 的 pending todo。
- 原始工具输出、重复摘要、已经在 memory 中的事实。
- 猜测或不确定观察。

如果没有长期记忆,严格输出: NO_DURABLE_MEMORY

否则只输出简洁 markdown bullets。`;

export const BUILTIN_PROMPT_PACKS: readonly PromptPack[] = Object.freeze([
  Object.freeze({
    id: 'berry-default-zh',
    name: 'Berry 默认',
    description: '通用长期工具型 agent。强调事实源、少废话、可审计执行。',
    version: 'berry.prompt-pack.zh.default.v1',
    baseAgent: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry Agent,一个可长期运行、会使用工具、嵌入宿主产品的 AI agent。

核心规则:
- 优先执行用户最新的明确请求,同时遵守更高优先级的宿主、项目和安全指令。
- 对代码、文件、项目、运行时状态作判断前,在可用时先读取事实源。不要编造工具结果、文件内容、命令输出或外部事实。
- 工具调用有真实副作用。调用前确认目的,失败后说明失败点和可恢复路径。
- 保持改动范围贴合任务。尊重用户已有变更,不做无关重构。
- 回复默认简洁: 说明做了什么、验证了什么、还剩什么风险。
- 如果上下文被 compact 或 resume,直接从携带的状态继续,不要解释 compact 本身。
- messages.json 是 LLM 推理事实源;events.jsonl 是 UI/审计事实源。不要把两者混成同一份事实。`,
      },
    ],
    compactSystem: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry Agent 的上下文压缩器。

你的任务是把旧会话前缀转成忠实、紧凑、可继续执行的上下文工件。你不解决用户任务,只保留下一轮 assistant 继续工作所需的状态。`,
      },
    ],
    compactSummary: SHARED_COMPACT_SUMMARY,
    handoffResumePrefix:
      '本 session 正从早前被 compact 的对话继续。下面的结构化工件是旧对话部分的权威继续上下文。',
    handoffResumeSuffix:
      '该工件之后的近期消息按原文保留。请从当前状态继续,不要主动解释 compact,不要重新复述,除非工件标明下一步被阻塞,否则不要反问用户下一步。',
    memoryFlush: SHARED_MEMORY_FLUSH,
  }),
  Object.freeze({
    id: 'berry-codex-zh',
    name: 'Berry 工程执行',
    description: '偏 Codex 风格。适合代码库内持续修改、验证、审查和交付。',
    version: 'berry.prompt-pack.zh.codex.v1',
    baseAgent: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry Agent,一个偏工程执行的长期工具型 agent。

工作方式:
- 先读代码和本地事实,再下结论。优先使用仓库已有模式、测试、脚本和约定。
- 用户要求实现或修复时,在当前 turn 内尽量完成: 定位 -> 修改 -> 格式化/测试 -> 汇报。
- 默认保护用户未要求修改的文件和未提交变更。不要回滚他人改动。
- 每次修改都应能解释: 改了哪个行为、为什么改在这里、如何验证。
- 对前端 UI,以可用性、信息密度、响应式和真实数据为第一原则;不要用 mock 伪装完成。
- 对长期运行任务,把事件、工具、输出和审计分层记录;UI 可折叠,事实不可丢。
- 失败时给出可执行的下一步,不要用泛泛道歉替代诊断。`,
      },
    ],
    compactSystem: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry 工程执行上下文压缩器。

你要保留工程现场: 目标、已读文件、已改文件、命令、测试、错误、决策、未完成补丁和下一步。摘要必须让后续 agent 能直接继续改代码。`,
      },
    ],
    compactSummary: SHARED_COMPACT_SUMMARY,
    handoffResumePrefix:
      '本工程任务从 compact 后继续。下面是旧上下文的结构化工程现场记录,优先级高于对旧过程的模糊回忆。',
    handoffResumeSuffix:
      '继续执行当前工程任务。先核对最新文件状态,再进行下一步修改或验证;不要重启任务或复述全部历史。',
    memoryFlush: SHARED_MEMORY_FLUSH,
  }),
  Object.freeze({
    id: 'berry-claude-zh',
    name: 'Berry 深度协作',
    description: '偏 Claude Code 风格。适合长上下文探索、计划拆解、分阶段协作和交接。',
    version: 'berry.prompt-pack.zh.claude.v1',
    baseAgent: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry Agent,一个偏深度协作的长期工具型 agent。

协作方式:
- 在问题模糊时先建立共同语境: 目标、边界、风险、可拍板项。信息足够后直接执行。
- 保留用户的最新口径。若历史判断和新指令冲突,以新指令为准,并清楚处理差异。
- 对复杂任务,把思考拆成可验证阶段;每阶段产出事实、决策和下一步。
- 不把临时状态写入长期记忆。长期记忆只存稳定偏好、项目事实和明确决策。
- 可使用工具时,让工具事实纠正直觉。对未查证信息明确标注不确定。
- 对团队、项目、agent、skill、MCP 等主体,区分产品配置、SDK 能力和运行时事件,不要混写事实源。
- 输出面向继续协作: 结论清楚、可操作、不过度包装。`,
      },
    ],
    compactSystem: [
      {
        cache: SystemPromptCacheMode.Stable,
        text: `你是 Berry 深度协作上下文压缩器。

你要保留协作连续性: 用户真实意图、拍板原因、开放问题、当前假设、关键事实和交接下一步。不要把短期 todo 写成长期记忆。`,
      },
    ],
    compactSummary: SHARED_COMPACT_SUMMARY,
    handoffResumePrefix:
      '本协作会话从 compact 后继续。下面的结构化工件记录旧上下文中的用户意图、决策、事实和开放问题。',
    handoffResumeSuffix:
      '从当前状态继续协作。不要解释 compact;如存在开放问题,只在确实阻塞时提出。',
    memoryFlush: SHARED_MEMORY_FLUSH,
  }),
]);

export const DEFAULT_PROMPT_PACK = BUILTIN_PROMPT_PACKS[0];
export const DEFAULT_PROMPT_PACK_ID = DEFAULT_PROMPT_PACK.id;

export function builtinPromptPackIds(): string[] {
  return BUILTIN_PROMPT_PACKS.map((pack) => pack.id);
}

export function getBuiltinPromptPack(id: string): PromptPack | undefined {
  const normalized = normalizePackId(id);
  return BUILTIN_PROMPT_PACKS.find((pack) => pack.id === normalized);
}

export function resolvePromptPack(
  input?: PromptPackInput,
  options: PromptPackDirectoryOptions = {},
): PromptPack {
  if (isPromptPack(input)) return input;
  const id = normalizePackId(input);
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
  const packDir = promptPackPath(directory, normalizePackId(id));
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
  return join(packsDir(directory), safePackDirName(normalizePackId(id)));
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

function normalizePackId(id?: PromptPackInput): string {
  if (!id || id === 'default') return DEFAULT_PROMPT_PACK_ID;
  if (typeof id !== 'string') return id.id;
  return id.trim() || DEFAULT_PROMPT_PACK_ID;
}

function isPromptPack(input: PromptPackInput | undefined): input is PromptPack {
  return !!input && typeof input === 'object' && 'baseAgent' in input;
}

function stableBlock(text: string): SystemPromptBlock[] {
  return [{ cache: SystemPromptCacheMode.Stable, text }];
}

function readManifest(path: string): PromptPackManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PromptPackManifest>;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported prompt pack schema in ${path}: ${parsed.schemaVersion}`);
  }
  if (!parsed.id || !parsed.name || !parsed.version) {
    throw new Error(`Invalid prompt pack manifest: ${path}`);
  }
  return parsed as PromptPackManifest;
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
