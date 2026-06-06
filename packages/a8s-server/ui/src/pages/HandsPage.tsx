import { useState } from 'react';
import { Card, Button, Tag, Select, Modal, Message, Popconfirm, Typography } from '@arco-design/web-react';
import {
  useHandRecipes, useLandHandRecipe, useDeleteHandRecipe, useMachines,
  type HandRecipe,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Hand 市场 — machine-bound capability bundles (甲1 model on Arco)
// ============================================================
// A Hand is a GROUP of capabilities (shell exec + a group of MCP servers)
// bound to ONE machine — the binding is machine-inborn (chosen when the recipe
// is authored). One card == one Hand. Cards are grouped by their free-assembly
// `group` label (e.g. 系统预装) purely for convenience.
//
// Two distinct actions: SELECTING a Hand onto an agent (done on the agent
// config page — grants the machine) vs LANDING the recipe's .mcp.json onto the
// machine (the operator step here). Secrets never live in a recipe — it
// references env var NAMES (${GITHUB_TOKEN}); the value is the machine owner's
// asset on the machine.

const UNGROUPED = '其它';

export function HandsPage() {
  const recipes = useHandRecipes();
  const machines = useMachines();
  const land = useLandHandRecipe();
  const del = useDeleteHandRecipe();
  const [landing, setLanding] = useState<HandRecipe | null>(null);

  if (recipes.error) return <ErrorBanner error={recipes.error} />;
  if (!recipes.data) return <Spinner />;

  // Group by the convenience `group` label; built-ins float their group first.
  const groups = new Map<string, HandRecipe[]>();
  for (const r of recipes.data) {
    const key = r.group ?? UNGROUPED;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === '系统预装') return -1;
    if (b === '系统预装') return 1;
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Hand 市场"
        subtitle={`${recipes.data.length} 个 Hand · 一个 Hand = 一台机器上的一组能力(exec + 一组 MCP)`}
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-5 max-w-3xl text-sm">
        一个 <strong>Hand</strong> 是绑定在某台机器上的一组能力。给 agent 配置时<strong>勾选 Hand</strong>即把这台机器授权给它(agent 得到 machine exec,并经 berry-mcp 触达其 MCP);
        而把 Hand 的 <code className="font-mono text-xs mx-0.5">.mcp.json</code> <strong>落地</strong>到机器是独立的运维步(下方按钮)。
        密钥不进 Hand——只引用环境变量<strong>名</strong>(如 <code className="font-mono text-xs mx-0.5">{'${GITHUB_TOKEN}'}</code>),值是机主自己机器上的资产。
      </Typography.Paragraph>

      {recipes.data.length === 0 ? (
        <EmptyState icon="🖐" title="还没有 Hand" hint="内置 Hand 应随 a8s 提供;若为空,请检查 a8s 版本。" />
      ) : (
        orderedGroups.map(([group, items]) => (
          <section key={group} className="mb-7">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-2)' }}>{group}</h2>
              <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{items.length}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {items.map((r) => (
                <RecipeCard
                  key={r.id}
                  recipe={r}
                  onLand={() => setLanding(r)}
                  onDelete={r.builtin ? undefined : () => { void del.mutateAsync(r.id).then(() => Message.success(`已删除「${r.name}」`)); }}
                />
              ))}
            </div>
          </section>
        ))
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
            Message.success(`已把「${landing.name}」落地到 ${machineId} — 现有 MCP servers: ${res.mcpServers.join(', ') || '(无)'}`);
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
    <Card
      bordered
      hoverable
      bodyStyle={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>{recipe.name}</h3>
            {recipe.builtin && <Tag size="small">内置</Tag>}
          </div>
          <code className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{recipe.id}</code>
        </div>
        {recipe.machineId
          ? <Tag color="arcoblue" size="small" className="shrink-0">🖥 {recipe.machineId}</Tag>
          : <Tag size="small" className="shrink-0">未绑机</Tag>}
      </div>

      {recipe.description && (
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>{recipe.description}</p>
      )}

      <div className="text-xs space-y-1.5" style={{ color: 'var(--color-text-3)' }}>
        <div className="flex gap-1.5 items-baseline flex-wrap">
          <span>MCP:</span>
          {servers.length > 0
            ? servers.map((s) => <Tag key={s} size="small" color="cyan">{s}</Tag>)
            : <span className="font-mono">—</span>}
        </div>
        {recipe.envVarNames.length > 0 && (
          <div className="flex gap-1.5 items-baseline flex-wrap">
            <span>需要密钥(机器本机):</span>
            {recipe.envVarNames.map((n) => (
              <code key={n} className="font-mono" style={{ color: 'rgb(var(--orange-6))' }}>${'{'}{n}{'}'}</code>
            ))}
          </div>
        )}
        {recipe.installCommands.length > 0 && (
          <div>安装命令: <span className="font-mono">{recipe.installCommands.length} 条</span></div>
        )}
      </div>

      <div className="flex gap-2 mt-auto pt-1">
        <Button type="primary" size="small" onClick={onLand}>落地到机器…</Button>
        {onDelete && (
          <Popconfirm title={`删除「${recipe.name}」?`} okText="删除" cancelText="取消" onOk={onDelete}>
            <Button type="text" status="danger" size="small">删除</Button>
          </Popconfirm>
        )}
      </div>
    </Card>
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
  // Default to the recipe's bound machine when present and active.
  const preferred = recipe.machineId && machines.includes(recipe.machineId) ? recipe.machineId : machines[0] ?? '';
  const [machineId, setMachineId] = useState<string>(preferred);
  return (
    <Modal
      visible
      title={`落地「${recipe.name}」`}
      onCancel={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={pending} disabled={!machineId} onClick={() => void onLand(machineId)}>落地</Button>
        </div>
      }
    >
      <p className="text-sm mb-3" style={{ color: 'var(--color-text-2)' }}>
        选一台活跃机器,a8s 会把这个 Hand 的 MCP 配置写到它的
        <code className="font-mono text-xs mx-1">.mcp.json</code> 并热重载连接器。
        {recipe.envVarNames.length > 0 && (
          <> 该 Hand 需要机器本机已存在环境变量:{' '}
            {recipe.envVarNames.map((n) => <code key={n} className="font-mono mx-0.5" style={{ color: 'rgb(var(--orange-6))' }}>{n}</code>)}。
          </>
        )}
      </p>

      {machines.length === 0 ? (
        <div className="text-sm" style={{ color: 'rgb(var(--red-6))' }}>没有活跃的机器。先在「Machines」里添加一台。</div>
      ) : (
        <Select value={machineId} onChange={setMachineId} placeholder="目标机器">
          {machines.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
        </Select>
      )}

      {error ? <div className="text-sm mt-3" style={{ color: 'rgb(var(--red-6))' }}>{error instanceof Error ? error.message : String(error)}</div> : null}
    </Modal>
  );
}
