// ============================================================
// @berry-agent/a8s-server — Hand recipe store
// ============================================================
//
// The registry behind lanxuan's option C: a machine offers only an
// environment (shell exec), and the capabilities a Hand grasps are
// configured remotely. A recipe is the blueprint — "what this Hand is made
// of, on which machine" — and this store is a8s's market of them. Every
// recipe is machine-bound (machine-inborn); the operator authors them.
//
// Persistence mirrors ModelsTemplateStore: one JSON file, in-memory cache,
// atomic tmp+rename write (single a8s process per store path, so no
// cross-process locking needed).
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
  private recipes = new Map<string, HandRecipe>();
  private loaded = false;

  constructor(options: HandRecipeStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger ?? console;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedShape;
      const next = new Map<string, HandRecipe>();
      for (const entry of parsed.recipes ?? []) {
        const recipe = handRecipeSchema.parse(entry);
        next.set(recipe.id, recipe);
      }
      this.recipes = next;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        this.logger.warn?.(`[hand-recipes] read failed: ${(err as Error).message}`);
      }
      this.recipes = new Map();
    }
    this.loaded = true;
  }

  /** All recipes, sorted by id. */
  async list(): Promise<HandRecipe[]> {
    await this.ensureLoaded();
    return [...this.recipes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<HandRecipe | null> {
    await this.ensureLoaded();
    return this.recipes.get(id) ?? null;
  }

  /** Register or update a recipe. */
  async register(req: HandRecipeRegisterRequest): Promise<HandRecipe> {
    await this.ensureLoaded();
    const recipe = handRecipeSchema.parse(req);
    this.recipes.set(recipe.id, recipe);
    await this.persist();
    return recipe;
  }

  /** Remove a recipe. Returns false if absent. */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const had = this.recipes.delete(id);
    if (had) await this.persist();
    return had;
  }

  private async persist(): Promise<void> {
    const record: PersistedShape = {
      recipes: [...this.recipes.values()],
      updatedAt: Date.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }
}
