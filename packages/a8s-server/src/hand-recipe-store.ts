// ============================================================
// @berry-agent/a8s-server — Hand recipe store
// ============================================================
//
// The registry behind lanxuan's option C: a machine offers only an
// environment (shell exec), and the capabilities a Hand grasps are
// configured remotely. A recipe is the env-agnostic blueprint — "what
// this Hand is made of" — and this store is a8s's market of them.
//
// Persistence mirrors ModelsTemplateStore: one JSON file, in-memory cache,
// atomic tmp+rename write (single a8s process per store path, so no
// cross-process locking needed). Built-in recipes are seeded in memory at
// every boot and never written to disk; only operator-registered recipes
// persist. A registered recipe may NOT reuse a built-in id (built-ins are
// read-only), and built-ins always shadow on read so a corrupt disk file
// can't mask a shipped capability.
//
// Secrets never live here. A recipe references env var *names*
// (`GITHUB_TOKEN`); the value is the machine owner's asset, present only in
// the machine's own environment. See cluster-protocol's handRecipeSchema.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  handRecipeSchema,
  type HandRecipe,
  type HandRecipeRegisterRequest,
} from '@berry-agent/cluster-protocol';

/** Recipes a8s ships out of the box. No-secret by default so they land clean. */
export const BUILTIN_HAND_RECIPES: HandRecipe[] = [
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    description: '一个由 Playwright 驱动的浏览器 Hand:导航、点击、抓取页面。无需密钥,落地即用。',
    kind: 'machine',
    group: '系统预装',
    mcpServers: {
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless'],
      },
    },
    installCommands: [],
    envVarNames: [],
    builtin: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub MCP Hand:读写 issue/PR/仓库。需要机器本机环境里存在 GITHUB_TOKEN。',
    kind: 'machine',
    group: '系统预装',
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
      },
    },
    installCommands: [],
    envVarNames: ['GITHUB_TOKEN'],
    builtin: true,
  },
];

export interface HandRecipeStoreOptions {
  /** Path to the JSON file holding operator-registered recipes. */
  filePath: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface PersistedShape {
  recipes: HandRecipe[];
  updatedAt: number;
}

export class HandRecipeStore {
  private readonly filePath: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly builtins: Map<string, HandRecipe>;
  // Operator-registered recipes, lazily loaded from disk. Built-ins are NOT
  // in here — they're merged at read time so they always win.
  private custom = new Map<string, HandRecipe>();
  private loaded = false;

  constructor(options: HandRecipeStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? console;
    this.builtins = new Map(BUILTIN_HAND_RECIPES.map((r) => [r.id, r]));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShape;
      const next = new Map<string, HandRecipe>();
      for (const entry of parsed.recipes ?? []) {
        const recipe = handRecipeSchema.parse(entry);
        // Legacy disk files persisted kind:'mcp'; normalize to 'machine' (the
        // schema accepts 'mcp' on read only for this back-compat).
        if (recipe.kind === 'mcp') recipe.kind = 'machine';
        // A disk file can't override a built-in id (built-ins are read-only).
        if (this.builtins.has(recipe.id)) continue;
        next.set(recipe.id, recipe);
      }
      this.custom = next;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        this.logger.warn?.(`[hand-recipes] read failed: ${(err as Error).message}`);
      }
      this.custom = new Map();
    }
    this.loaded = true;
  }

  /** All recipes (built-ins first, then operator recipes), sorted by id. */
  async list(): Promise<HandRecipe[]> {
    await this.ensureLoaded();
    const merged = new Map<string, HandRecipe>(this.builtins);
    for (const [id, recipe] of this.custom) merged.set(id, recipe);
    return [...merged.values()].sort((a, b) => {
      // built-ins float to the top, then alphabetical.
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  async get(id: string): Promise<HandRecipe | null> {
    await this.ensureLoaded();
    return this.builtins.get(id) ?? this.custom.get(id) ?? null;
  }

  /**
   * Register or update an operator recipe. Forces `builtin: false` (only the
   * shipped set is built-in) and rejects reuse of a built-in id so a shipped
   * capability can't be silently shadowed.
   */
  async register(req: HandRecipeRegisterRequest): Promise<HandRecipe> {
    await this.ensureLoaded();
    if (this.builtins.has(req.id)) {
      throw new Error(`recipe id "${req.id}" is built-in and cannot be overwritten`);
    }
    const recipe = handRecipeSchema.parse({ ...req, builtin: false });
    // Always persist as 'machine' — 'mcp' is a read-only legacy alias.
    if (recipe.kind === 'mcp') recipe.kind = 'machine';
    this.custom.set(recipe.id, recipe);
    await this.persist();
    return recipe;
  }

  /** Remove an operator recipe. Built-ins can't be removed. Returns false if absent. */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    if (this.builtins.has(id)) {
      throw new Error(`recipe id "${id}" is built-in and cannot be removed`);
    }
    const had = this.custom.delete(id);
    if (had) await this.persist();
    return had;
  }

  private async persist(): Promise<void> {
    const record: PersistedShape = {
      recipes: [...this.custom.values()],
      updatedAt: Date.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }
}
