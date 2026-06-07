import { useState } from 'react';
import { Card, Button, Tag, Select, Modal, Message, Popconfirm, Typography, Input, Checkbox } from '@arco-design/web-react';
import {
  useHandRecipes, useDeleteHandRecipe, useRegisterHandRecipe, useMachines,
  type HandRecipe, type Machine,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Hand 市场 — capability bundles that reference a machine's MCP
// ============================================================
// A Hand = an environment (a machine, which provides shell exec + the common
// tool list) + a referenced subset of the MCP servers that machine exposes.
// The Hand carries NO MCP config — the machine's .mcp.json is the single source
// of truth (authored on the Machines page). Many Hands can share one machine.
//
// Selecting a Hand onto an agent grants its machine (the agent gets
// machine_<id>_exec + reaches the machine's MCP via berry-mcp). There is no
// "land" step — the MCP already lives on the machine.

const UNGROUPED = '其它';

export function HandsPage() {
  const recipes = useHandRecipes();
  const machines = useMachines();
  const del = useDeleteHandRecipe();
  const register = useRegisterHandRecipe();
  const [creating, setCreating] = useState(false);

  if (recipes.error) return <ErrorBanner error={recipes.error} />;
  if (!recipes.data) return <Spinner />;

  const activeMachines = (machines.data ?? []).filter((m) => m.state === 'active');

  // Group by the convenience `group` label; 系统预装 floats first.
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
        subtitle={`${recipes.data.length} 个 Hand · 一个 Hand = 选一个环境(机器)+ 引用它暴露的 MCP 子集`}
        actions={<Button type="primary" onClick={() => setCreating(true)}>创建 Hand</Button>}
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-5 max-w-3xl text-sm">
        一个 <strong>Hand</strong> = 选一个<strong>环境</strong>(机器,提供 shell exec + 通用工具)+ 引用该机已暴露的一部分 <strong>MCP server</strong>。
        给 agent <strong>勾选 Hand</strong> 即把这台机器授权给它(agent 得到 machine exec,并经 berry-mcp 触达其 MCP)。
        MCP 的<strong>唯一事实源是机器的 <code className="font-mono text-xs mx-0.5">.mcp.json</code></strong>——在「Machines」页远程设置;Hand 只<strong>引用</strong>名字,自己不存配置。
      </Typography.Paragraph>

      {recipes.data.length === 0 ? (
        <EmptyState icon="🖐" title="还没有 Hand" hint="点「创建 Hand」:选一台机器,从它暴露的 MCP 里挑一组。" />
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
                  onDelete={() => { void del.mutateAsync(r.id).then(() => Message.success(`已删除「${r.name}」`)); }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {creating && (
        <CreateHandModal
          machines={activeMachines}
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

function RecipeCard({ recipe, onDelete }: { recipe: HandRecipe; onDelete: () => void }) {
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

      <div className="text-xs flex gap-1.5 items-baseline flex-wrap" style={{ color: 'var(--color-text-3)' }}>
        <span>MCP:</span>
        {recipe.mcpServerRefs.length > 0
          ? recipe.mcpServerRefs.map((s) => <Tag key={s} size="small" color="cyan">{s}</Tag>)
          : <span className="font-mono">— 仅 exec</span>}
      </div>

      <div className="flex gap-2 mt-auto pt-1">
        <Popconfirm title={`删除「${recipe.name}」?`} okText="删除" cancelText="取消" onOk={onDelete}>
          <Button type="text" status="danger" size="small">删除</Button>
        </Popconfirm>
      </div>
    </Card>
  );
}

// ============================================================
// 创建 Hand — pick a machine, then check which of its exposed MCP to reference
// ============================================================

function CreateHandModal({ machines, pending, error, onClose, onCreate }: {
  machines: Machine[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (recipe: HandRecipe) => void | Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [machineId, setMachineId] = useState<string>(machines[0]?.machineId ?? '');
  const [group, setGroup] = useState('');
  const [refs, setRefs] = useState<string[]>([]);

  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const canSubmit = idValid && name.trim() && machineId && !pending;

  // The chosen machine's exposed MCP servers — the universe a Hand can reference.
  const chosen = machines.find((m) => m.machineId === machineId);
  const exposed = chosen?.mcpServers ?? [];

  const submit = () => {
    void onCreate({
      id,
      name: name.trim(),
      description: description.trim() || undefined,
      machineId,
      group: group.trim() || undefined,
      mcpServerRefs: refs.filter((r) => exposed.includes(r)),
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
          <Input className="mt-1 font-mono" value={id} onChange={setId} placeholder="e.g. office-mac-web" autoFocus />
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
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>环境(机器)</span>
          {machines.length === 0 ? (
            <div className="text-sm mt-1" style={{ color: 'rgb(var(--red-6))' }}>没有活跃的机器。先在「Machines」里接入一台。</div>
          ) : (
            <Select className="mt-1" value={machineId} onChange={(v) => { setMachineId(v); setRefs([]); }} placeholder="选一台已接入的机器">
              {machines.map((m) => <Select.Option key={m.machineId} value={m.machineId}>{m.machineId}</Select.Option>)}
            </Select>
          )}
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>分组(可选)</span>
          <Input className="mt-1" value={group} onChange={setGroup} placeholder="e.g. 系统预装" />
        </label>
      </div>

      <div className="block mt-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>引用该机暴露的 MCP server(可不选 = 仅 exec)</span>
        {exposed.length === 0 ? (
          <div className="text-xs mt-1" style={{ color: 'var(--color-text-3)' }}>
            这台机器没有暴露 MCP。去「Machines」页给它设置 <code className="font-mono">.mcp.json</code>,或创建一个仅 exec 的 Hand。
          </div>
        ) : (
          <Checkbox.Group className="mt-1 flex flex-wrap gap-3" value={refs} onChange={setRefs}>
            {exposed.map((s) => <Checkbox key={s} value={s}>{s}</Checkbox>)}
          </Checkbox.Group>
        )}
      </div>

      {error ? <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{error instanceof Error ? error.message : String(error)}</div> : null}
    </Modal>
  );
}
