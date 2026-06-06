import { useState } from 'react';
import {
  useHandRecipes, useLandHandRecipe, useDeleteHandRecipe, useMachines,
  type HandRecipe,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Hand 市场 — env-agnostic capability recipes + remote landing
// ============================================================
// A machine offers only an environment (shell exec). The capabilities a Hand
// grasps are configured here and landed remotely onto a machine: a8s writes
// the recipe's .mcp.json fragment over the exec broker and reloads the
// connector. Secrets never live in a recipe — it references env var NAMES
// (${GITHUB_TOKEN}), the value is the machine owner's asset on the machine.

export function HandsPage() {
  const recipes = useHandRecipes();
  const machines = useMachines();
  const land = useLandHandRecipe();
  const del = useDeleteHandRecipe();
  const [landing, setLanding] = useState<HandRecipe | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  if (recipes.error) return <ErrorBanner error={recipes.error} />;
  if (!recipes.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Hand 市场"
        subtitle={`${recipes.data.length} 个配方 · 选 env、选能力,落地即得一个 Hand`}
      />

      <p className="text-sm text-ink-500 dark:text-ink-400 -mt-3 mb-4 max-w-3xl">
        一个 <strong>Hand 配方</strong> 是与机器无关的能力蓝图——它描述「这个 Hand 装了什么」。
        机器只提供 env(shell exec);把配方<strong>落地</strong>到一台机器,a8s 会通过 exec 通道把
        <code className="font-mono text-xs mx-1">.mcp.json</code> 写到机器上并热重载连接器,新的 MCP 能力随即作为 Hand 出现。
        密钥不进配方——配方只引用环境变量<strong>名</strong>(如
        <code className="font-mono text-xs mx-1">{'${GITHUB_TOKEN}'}</code>),值是机主自己机器上的资产。
      </p>

      {flash && (
        <div className="card mb-4 border-snow-300 bg-snow-50 dark:border-snow-900 dark:bg-snow-950/30 text-snow-700 dark:text-snow-300 text-sm">
          {flash}
        </div>
      )}

      {recipes.data.length === 0 ? (
        <EmptyState icon="🖐" title="还没有 Hand 配方" hint="内置配方应随 a8s 提供;若为空,请检查 a8s 版本。" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {recipes.data.map((r) => (
            <RecipeCard
              key={r.id}
              recipe={r}
              onLand={() => setLanding(r)}
              onDelete={r.builtin ? undefined : () => { void del.mutateAsync(r.id); }}
            />
          ))}
        </div>
      )}

      {landing && (
        <LandModal
          recipe={landing}
          machines={(machines.data ?? []).filter((m) => m.state === 'active').map((m) => m.machineId)}
          pending={land.isPending}
          error={land.error}
          onClose={() => setLanding(null)}
          onLand={async (machineId) => {
            const res = await land.mutateAsync({ machineId, recipeId: landing.id });
            setFlash(`已把「${landing.name}」落地到 ${machineId} — 现有 MCP servers: ${res.mcpServers.join(', ') || '(无)'}`);
            setLanding(null);
          }}
        />
      )}
    </div>
  );
}

function RecipeCard({ recipe, onLand, onDelete }: {
  recipe: HandRecipe;
  onLand: () => void;
  onDelete?: () => void;
}) {
  const servers = Object.keys(recipe.mcpServers);
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate">{recipe.name}</h3>
            {recipe.builtin && <span className="pill pill-muted text-[10px]">内置</span>}
          </div>
          <code className="font-mono text-xs text-ink-400">{recipe.id}</code>
        </div>
        <span className="pill pill-info text-[10px] shrink-0">{recipe.kind.toUpperCase()}</span>
      </div>

      {recipe.description && (
        <p className="text-sm text-ink-600 dark:text-ink-300">{recipe.description}</p>
      )}

      <dl className="text-xs text-ink-500 dark:text-ink-400 space-y-1">
        <div><span className="text-ink-400">MCP servers:</span> <span className="font-mono">{servers.join(', ') || '—'}</span></div>
        {recipe.envVarNames.length > 0 && (
          <div>
            <span className="text-ink-400">需要密钥(机器本机):</span>{' '}
            {recipe.envVarNames.map((n) => (
              <code key={n} className="font-mono text-amber-600 dark:text-amber-400 mr-1">${'{'}{n}{'}'}</code>
            ))}
          </div>
        )}
        {recipe.installCommands.length > 0 && (
          <div><span className="text-ink-400">安装命令:</span> <span className="font-mono">{recipe.installCommands.length} 条</span></div>
        )}
      </dl>

      <div className="flex gap-2 mt-auto pt-1">
        <button type="button" className="btn btn-primary" onClick={onLand}>落地到机器…</button>
        {onDelete && (
          <button type="button" className="btn btn-ghost text-berry-600" onClick={onDelete}>删除</button>
        )}
      </div>
    </div>
  );
}

function LandModal({ recipe, machines, pending, error, onClose, onLand }: {
  recipe: HandRecipe;
  machines: string[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onLand: (machineId: string) => void | Promise<void>;
}) {
  const [machineId, setMachineId] = useState<string>(machines[0] ?? '');
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">落地「{recipe.name}」</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="text-sm text-ink-500 dark:text-ink-400 mb-3">
          选一台活跃机器,a8s 会把这个 Hand 的 MCP 配置写到它的
          <code className="font-mono text-xs mx-1">.mcp.json</code> 并热重载连接器。
          {recipe.envVarNames.length > 0 && (
            <> 该 Hand 需要机器本机已存在环境变量:{' '}
              {recipe.envVarNames.map((n) => <code key={n} className="font-mono text-amber-600 mr-1">{n}</code>)}。
            </>
          )}
        </p>

        {machines.length === 0 ? (
          <div className="text-sm text-berry-600 dark:text-berry-400 mb-3">没有活跃的机器。先在「Machines」里添加一台。</div>
        ) : (
          <label className="block mb-3">
            <span className="text-xs text-ink-500">目标机器</span>
            <select
              className="input mt-1 w-full"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
            >
              {machines.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}

        {error ? <div className="text-sm text-berry-600 dark:text-berry-400 mb-3">{error instanceof Error ? error.message : String(error)}</div> : null}

        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={pending || !machineId}
            onClick={() => void onLand(machineId)}
          >
            {pending ? '落地中…' : '落地'}
          </button>
        </div>
      </div>
    </div>
  );
}
