import { useState } from 'react';
import { Card, Button, Tag, Select, Modal, Message, Popconfirm, Typography, Input } from '@arco-design/web-react';
import {
  useHandRecipes, useLandHandRecipe, useDeleteHandRecipe, useRegisterHandRecipe, useMachines,
  type HandRecipe,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Hand 市场 — machine-bound capability bundles (machine-inborn)
// ============================================================
// A Hand is a GROUP of capabilities (shell exec + a group of MCP servers)
// bound to ONE machine — the binding is machine-inborn (chosen at creation).
// One card == one Hand. Cards are grouped by their free-assembly `group` label
// (e.g. 系统预装) purely for convenience.
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
  const register = useRegisterHandRecipe();
  const [landing, setLanding] = useState<HandRecipe | null>(null);
  const [creating, setCreating] = useState(false);

  if (recipes.error) return <ErrorBanner error={recipes.error} />;
  if (!recipes.data) return <Spinner />;

  const activeMachineIds = (machines.data ?? []).filter((m) => m.state === 'active').map((m) => m.machineId);

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
        actions={<Button type="primary" onClick={() => setCreating(true)}>创建 Hand</Button>}
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-5 max-w-3xl text-sm">
        一个 <strong>Hand</strong> 是绑定在某台机器上的一组能力。给 agent 配置时<strong>勾选 Hand</strong>即把这台机器授权给它(agent 得到 machine exec,并经 berry-mcp 触达其 MCP);
        而把 Hand 的 <code className="font-mono text-xs mx-0.5">.mcp.json</code> <strong>落地</strong>到机器是独立的运维步(下方按钮)。
        密钥不进 Hand——只引用环境变量<strong>名</strong>(如 <code className="font-mono text-xs mx-0.5">{'${GITHUB_TOKEN}'}</code>),值是机主自己机器上的资产。
      </Typography.Paragraph>

      {recipes.data.length === 0 ? (
        <EmptyState icon="🖐" title="还没有 Hand" hint="点「创建 Hand」绑定一台已接入的机器,粘上它的 MCP 配置。" />
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
                  onDelete={() => { void del.mutateAsync(r.id).then(() => Message.success(`已删除「${r.name}」`)); }}
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

      {creating && (
        <CreateHandModal
          machineIds={activeMachineIds}
          pending={register.isPending}
          error={register.error}
          onClose={() => setCreating(false)}
          onCreate={async (recipe) => {
            await register.mutateAsync(recipe);
            Message.success(`已创建「${recipe.name}」`);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function RecipeCard({ recipe, onLand, onDelete }: {
  recipe: HandRecipe;
  onLand: () => void;
  onDelete: () => void;
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
          <h3 className="font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>{recipe.name}</h3>
          <code className="font-mono text-xs" style={{ color: 'var(--color-text-3)' }}>{recipe.id}</code>
        </div>
        <Tag color="arcoblue" size="small" className="shrink-0">🖥 {recipe.machineId}</Tag>
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
        <Popconfirm title={`删除「${recipe.name}」?`} okText="删除" cancelText="取消" onOk={onDelete}>
          <Button type="text" status="danger" size="small">删除</Button>
        </Popconfirm>
      </div>
    </Card>
  );
}

// ============================================================
// 创建 Hand — model A: operator-authored, machine-bound, raw-JSON paste
// ============================================================
// The operator picks an already-connected machine (machine-inborn) and pastes
// the mcpServers fragment of an .mcp.json. We extract the `${VAR}` env-var
// names from the pasted JSON automatically — the operator never types secrets,
// only references their names.

/** Collect distinct `${VAR}` references from arbitrary JSON text. */
function extractEnvVarNames(jsonText: string): string[] {
  const names = new Set<string>();
  for (const m of jsonText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]);
  return [...names];
}

function CreateHandModal({ machineIds, pending, error, onClose, onCreate }: {
  machineIds: string[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (recipe: HandRecipe) => void | Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [machineId, setMachineId] = useState<string>(machineIds[0] ?? '');
  const [group, setGroup] = useState('');
  const [mcpJson, setMcpJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const canSubmit = idValid && name.trim() && machineId && mcpJson.trim() && !pending;

  const submit = () => {
    let mcpServers: Record<string, Record<string, unknown>>;
    try {
      const parsed = JSON.parse(mcpJson);
      // Accept either a bare mcpServers map or a full { mcpServers: {...} } doc.
      const servers = parsed && typeof parsed === 'object' && 'mcpServers' in parsed ? parsed.mcpServers : parsed;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        throw new Error('应是一个对象:{ "server-name": { "command": … } }');
      }
      mcpServers = servers as Record<string, Record<string, unknown>>;
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    setJsonError(null);
    void onCreate({
      id, name: name.trim(),
      description: description.trim() || undefined,
      machineId,
      group: group.trim() || undefined,
      mcpServers,
      installCommands: [],
      envVarNames: extractEnvVarNames(mcpJson),
    });
  };

  return (
    <Modal
      visible
      title="创建 Hand"
      onCancel={onClose}
      style={{ width: 560 }}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={pending} disabled={!canSubmit} onClick={submit}>创建</Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Hand ID(kebab-case)</span>
          <Input className="mt-1 font-mono" value={id} onChange={setId} placeholder="e.g. office-mac-github" autoFocus />
          {id.length > 0 && !idValid && (
            <div className="text-xs mt-1" style={{ color: 'rgb(var(--red-6))' }}>只能用小写字母、数字、横线,且以字母/数字开头。</div>
          )}
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>名称</span>
          <Input className="mt-1" value={name} onChange={setName} placeholder="给这个 Hand 起个名" />
        </label>
      </div>

      <label className="block mt-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>描述(可选)</span>
        <Input className="mt-1" value={description} onChange={setDescription} placeholder="这个 Hand 能做什么" />
      </label>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>绑定机器(创建时即绑机)</span>
          {machineIds.length === 0 ? (
            <div className="text-sm mt-1" style={{ color: 'rgb(var(--red-6))' }}>没有活跃的机器。先在「Machines」里接入一台。</div>
          ) : (
            <Select className="mt-1" value={machineId} onChange={setMachineId} placeholder="选一台已接入的机器">
              {machineIds.map((m) => <Select.Option key={m} value={m}>{m}</Select.Option>)}
            </Select>
          )}
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>分组(可选)</span>
          <Input className="mt-1" value={group} onChange={setGroup} placeholder="e.g. 系统预装" />
        </label>
      </div>

      <label className="block mt-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          MCP servers(粘贴 .mcp.json 的 <code className="font-mono">mcpServers</code> 片段)
        </span>
        <Input.TextArea
          className="mt-1 font-mono"
          value={mcpJson}
          onChange={setMcpJson}
          autoSize={{ minRows: 6, maxRows: 16 }}
          placeholder={'{\n  "github": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-github"],\n    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }\n  }\n}'}
        />
        <div className="text-xs mt-1" style={{ color: 'var(--color-text-3)' }}>
          其中的 <code className="font-mono">{'${VAR}'}</code> 会被自动识别为「机器本机需存在的密钥名」,a8s 不收集值。
        </div>
        {jsonError && <div className="text-xs mt-1" style={{ color: 'rgb(var(--red-6))' }}>JSON 解析失败:{jsonError}</div>}
      </label>

      {error ? <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{error instanceof Error ? error.message : String(error)}</div> : null}
    </Modal>
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
