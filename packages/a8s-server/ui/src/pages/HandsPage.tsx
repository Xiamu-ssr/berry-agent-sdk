import { useState } from 'react';
import {
  Card, Button, Tag, Modal, Message, Popconfirm, Typography, Input, Steps, Tooltip, Empty,
} from '@arco-design/web-react';
import {
  useHandRecipes, useDeleteHandRecipe, useRegisterHandRecipe, useMachines,
  type HandRecipe, type HandToolGroup, type Machine,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Hand 市场 — assembled over a machine, built by a pipeline wizard
// ============================================================
// A Hand = an environment (a machine, always-on shell exec) + chosen common
// tool groups + a referenced subset of the machine's exposed MCP. Creating one
// is a 3-step pipeline (选环境 → 选工具 → 选 MCP), not a form — the operator
// clicks through, never types more than a name. The machine's .mcp.json is the
// single source of truth for MCP (set on the Machines page); a Hand only
// references server names.

const UNGROUPED = '其它';

// The common tool families a Hand can grant, with human copy for the wizard.
// Descriptions stay hidden behind a hover tooltip — the card shows just a title.
const TOOL_GROUPS: Array<{ id: HandToolGroup | 'exec'; title: string; always?: boolean; desc: string; tools: string }> = [
  { id: 'exec', title: '机器 Shell', always: true, desc: '在这台机器的真实 shell 上跑命令(machine_<id>_exec)。选了环境就自带,不可取消。', tools: 'exec' },
  { id: 'workspace', title: '工作区', desc: '读写文件、跑 shell、代码搜索 —— 绑定到这台机器的执行环境。', tools: 'read_file · write_file · list_files · shell · grep' },
  { id: 'web', title: '联网', desc: '抓取网页、网络搜索 —— 不依赖某台机器,直接出网。', tools: 'web_fetch · web_search' },
];

export function HandsPage() {
  const recipes = useHandRecipes();
  const machines = useMachines();
  const del = useDeleteHandRecipe();
  const register = useRegisterHandRecipe();
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  if (recipes.error) return <ErrorBanner error={recipes.error} />;
  if (!recipes.data) return <Spinner />;

  const activeMachines = (machines.data ?? []).filter((m) => m.state === 'active');

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
        subtitle={`${recipes.data.length} 个 Hand · 一个 Hand = 环境 + 工具 + MCP,点几下就拼好`}
        actions={<Button type="primary" onClick={() => setCreating(true)}>创建 Hand</Button>}
      />

      <Typography.Paragraph type="secondary" className="-mt-3 mb-5 max-w-3xl text-sm">
        一个 <strong>Hand</strong> 在一台<strong>机器</strong>(环境)上拼装:机器自带 shell exec,你再勾选要的<strong>工具组</strong>和该机暴露的 <strong>MCP</strong>。
        给 agent 勾选 Hand 即把这台机器授权给它。MCP 的唯一事实源是机器的 <code className="font-mono text-xs mx-0.5">.mcp.json</code>——在「Machines」页设置。
      </Typography.Paragraph>

      {recipes.data.length === 0 ? (
        <EmptyState icon="🖐" title="还没有 Hand" hint="点「创建 Hand」,跟着三步选环境、选工具、选 MCP。" />
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
                  highlight={r.id === justCreated}
                  onDelete={() => { void del.mutateAsync(r.id).then(() => Message.success(`已删除「${r.name}」`)); }}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {creating && (
        <CreateHandWizard
          machines={activeMachines}
          pending={register.isPending}
          error={register.error}
          onClose={() => setCreating(false)}
          onCreate={async (recipe) => {
            await register.mutateAsync(recipe);
            setCreating(false);
            // Give the "it just appeared" feel: refetch + flash the new card.
            await recipes.refetch();
            setJustCreated(recipe.id);
            Message.success(`「${recipe.name}」已上架`);
            setTimeout(() => setJustCreated(null), 2200);
          }}
        />
      )}
    </div>
  );
}

function RecipeCard({ recipe, highlight, onDelete }: { recipe: HandRecipe; highlight?: boolean; onDelete: () => void }) {
  return (
    <Card
      bordered
      hoverable
      className={highlight ? 'animate-fade-in' : ''}
      style={highlight ? { boxShadow: '0 0 0 2px rgb(var(--arcoblue-6))', transition: 'box-shadow .3s' } : undefined}
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
        <span>工具:</span>
        <Tag size="small">机器 Shell</Tag>
        {recipe.toolGroups.map((g) => <Tag key={g} size="small">{g === 'workspace' ? '工作区' : '联网'}</Tag>)}
      </div>
      <div className="text-xs flex gap-1.5 items-baseline flex-wrap" style={{ color: 'var(--color-text-3)' }}>
        <span>MCP:</span>
        {recipe.mcpServerRefs.length > 0
          ? recipe.mcpServerRefs.map((s) => <Tag key={s} size="small" color="cyan">{s}</Tag>)
          : <span className="font-mono">—</span>}
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
// 创建 Hand 向导 — 选环境 → 选工具 → 选 MCP
// ============================================================

function CreateHandWizard({ machines, pending, error, onClose, onCreate }: {
  machines: Machine[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onCreate: (recipe: HandRecipe) => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [machineId, setMachineId] = useState<string>('');
  const [toolGroups, setToolGroups] = useState<HandToolGroup[]>(['workspace']);
  const [refs, setRefs] = useState<string[]>([]);
  // Only the final step needs a name; keep it minimal (auto-suggested).
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');

  const chosen = machines.find((m) => m.machineId === machineId);
  const exposed = chosen?.mcpServerDetails ?? [];
  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(id);

  const next = () => {
    // When leaving step 0, seed sensible name/id from the machine.
    if (step === 0 && machineId) {
      if (!id) setId(`${machineId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-hand`);
      if (!name) setName(`${machineId} Hand`);
    }
    setStep((s) => Math.min(s + 1, 3));
  };
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  const canNext =
    (step === 0 && !!machineId) ||
    (step === 1) ||
    (step === 2) ||
    (step === 3 && idValid && !!name.trim());

  const submit = () => {
    void onCreate({
      id, name: name.trim(),
      machineId,
      group: group.trim() || undefined,
      toolGroups,
      mcpServerRefs: refs.filter((r) => exposed.some((e) => e.server === r)),
    });
  };

  return (
    <Modal
      visible
      title="创建 Hand"
      onCancel={onClose}
      style={{ width: 720 }}
      footer={
        <div className="flex justify-between items-center">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            {machineId ? `环境 ${machineId}` : '先选一个环境'}
            {toolGroups.length > 0 ? ` · ${toolGroups.length + 1} 组工具` : ' · 仅 Shell'}
            {refs.length > 0 ? ` · ${refs.length} 个 MCP` : ''}
          </span>
          <div className="flex gap-2">
            {step > 0 && <Button onClick={prev}>上一步</Button>}
            {step < 3 && <Button type="primary" disabled={!canNext} onClick={next}>下一步</Button>}
            {step === 3 && <Button type="primary" loading={pending} disabled={!canNext} onClick={submit}>创建</Button>}
          </div>
        </div>
      }
    >
      <Steps current={step} size="small" className="mb-5">
        <Steps.Step title="选环境" description="哪台机器" />
        <Steps.Step title="选工具" description="给哪些能力" />
        <Steps.Step title="选 MCP" description="挂哪些服务" />
        <Steps.Step title="命名" description="确认上架" />
      </Steps>

      {step === 0 && <StepEnv machines={machines} value={machineId} onPick={(m) => { setMachineId(m); setRefs([]); }} />}
      {step === 1 && <StepTools value={toolGroups} onChange={setToolGroups} />}
      {step === 2 && <StepMcp exposed={exposed} value={refs} onChange={setRefs} machineId={machineId} />}
      {step === 3 && (
        <StepConfirm
          id={id} name={name} group={group} idValid={idValid}
          machineId={machineId} toolGroups={toolGroups} refs={refs}
          onId={setId} onName={setName} onGroup={setGroup}
        />
      )}

      {error ? <div className="text-sm mt-3" style={{ color: 'rgb(var(--red-6))' }}>{error instanceof Error ? error.message : String(error)}</div> : null}
    </Modal>
  );
}

// ---- Step 1: 选环境 (machine cards) ----
function StepEnv({ machines, value, onPick }: { machines: Machine[]; value: string; onPick: (id: string) => void }) {
  if (machines.length === 0) {
    return <Empty description={<span>没有活跃的机器。先去「Machines」页接入一台,再回来创建 Hand。</span>} />;
  }
  return (
    <div>
      <p className="text-sm mb-3" style={{ color: 'var(--color-text-2)' }}>选一台机器作为这个 Hand 的环境。它提供 shell,也是 MCP 的来源。</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {machines.map((m) => {
          const on = m.machineId === value;
          const desc = m.labels?.description ?? m.labels?.desc;
          return (
            <button
              key={m.machineId}
              onClick={() => onPick(m.machineId)}
              className="text-left rounded-md p-3 transition-all"
              style={{
                border: on ? '2px solid rgb(var(--arcoblue-6))' : '1px solid var(--color-border-2)',
                background: on ? 'var(--color-fill-1)' : 'var(--color-bg-2)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>🖥 {m.machineId}</code>
                {on && <Tag color="arcoblue" size="small">已选</Tag>}
              </div>
              <div className="flex gap-1.5 mt-1.5 flex-wrap items-center">
                {m.platform && <Tag size="small">{m.platform}</Tag>}
                <Tag size="small" color={m.mcpServers.length > 0 ? 'green' : undefined}>{m.mcpServers.length} MCP</Tag>
                <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{m.mcpToolCount} 工具</span>
              </div>
              {desc && <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-3)' }}>{desc}</p>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Step 2: 选工具 (grouped, hover for detail, one-click all) ----
function StepTools({ value, onChange }: { value: HandToolGroup[]; onChange: (v: HandToolGroup[]) => void }) {
  const optional = TOOL_GROUPS.filter((g) => !g.always);
  const allOn = optional.every((g) => value.includes(g.id as HandToolGroup));
  const toggle = (id: HandToolGroup) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>勾选这个 Hand 要的工具组。悬浮看每组包含什么。</p>
        <Button size="mini" onClick={() => onChange(allOn ? [] : optional.map((g) => g.id as HandToolGroup))}>
          {allOn ? '全不选' : '全选'}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {TOOL_GROUPS.map((g) => {
          const on = g.always || value.includes(g.id as HandToolGroup);
          return (
            <Tooltip key={g.id} content={<div className="text-xs"><div>{g.desc}</div><div className="mt-1 font-mono opacity-80">{g.tools}</div></div>}>
              <button
                disabled={g.always}
                onClick={() => !g.always && toggle(g.id as HandToolGroup)}
                className="text-left rounded-md p-3 w-full transition-all"
                style={{
                  border: on ? '2px solid rgb(var(--arcoblue-6))' : '1px solid var(--color-border-2)',
                  background: on ? 'var(--color-fill-1)' : 'var(--color-bg-2)',
                  cursor: g.always ? 'default' : 'pointer',
                  opacity: g.always ? 0.85 : 1,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-1)' }}>{g.title}</span>
                  {g.always ? <Tag size="small">自带</Tag> : on ? <Tag color="arcoblue" size="small">✓</Tag> : null}
                </div>
                <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--color-text-3)' }}>{g.tools}</p>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

// ---- Step 3: 选 MCP (checkbox cards with health) ----
function StepMcp({ exposed, value, onChange, machineId }: {
  exposed: Machine['mcpServerDetails']; value: string[]; onChange: (v: string[]) => void; machineId: string;
}) {
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  if (exposed.length === 0) {
    return (
      <Empty
        description={
          <span>
            机器 <code className="font-mono">{machineId}</code> 还没暴露 MCP。可以跳过(创建一个仅工具的 Hand),
            或先去「Machines」页给它「设置 MCP」。
          </span>
        }
      />
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>勾选这个 Hand 要挂的 MCP。绿点 = 连接器当前连得上。</p>
        <Button size="mini" onClick={() => onChange(value.length === exposed.length ? [] : exposed.map((e) => e.server))}>
          {value.length === exposed.length ? '全不选' : '全选'}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {exposed.map((e) => {
          const on = value.includes(e.server);
          return (
            <button
              key={e.server}
              onClick={() => toggle(e.server)}
              className="text-left rounded-md p-3 transition-all"
              style={{
                border: on ? '2px solid rgb(var(--arcoblue-6))' : '1px solid var(--color-border-2)',
                background: on ? 'var(--color-fill-1)' : 'var(--color-bg-2)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span style={{ width: 8, height: 8, borderRadius: 999, display: 'inline-block',
                    background: e.healthy ? 'rgb(var(--green-6))' : 'rgb(var(--gray-5))' }} />
                  <code className="font-mono text-sm" style={{ color: 'var(--color-text-1)' }}>{e.server}</code>
                </span>
                {on && <Tag color="arcoblue" size="small">✓</Tag>}
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-3)' }}>
                {e.healthy ? `健康 · ${e.toolCount} 个工具` : '未连接'}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Step 4: 命名确认 ----
function StepConfirm({ id, name, group, idValid, machineId, toolGroups, refs, onId, onName, onGroup }: {
  id: string; name: string; group: string; idValid: boolean;
  machineId: string; toolGroups: HandToolGroup[]; refs: string[];
  onId: (v: string) => void; onName: (v: string) => void; onGroup: (v: string) => void;
}) {
  return (
    <div>
      <div className="rounded-md p-3 mb-4" style={{ background: 'var(--color-fill-1)' }}>
        <div className="text-xs flex flex-wrap gap-x-4 gap-y-1.5" style={{ color: 'var(--color-text-2)' }}>
          <span>环境 <code className="font-mono">{machineId}</code></span>
          <span>工具 机器Shell{toolGroups.map((g) => ` · ${g === 'workspace' ? '工作区' : '联网'}`).join('')}</span>
          <span>MCP {refs.length > 0 ? refs.join(', ') : '—'}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Hand ID</span>
          <Input className="mt-1 font-mono" value={id} onChange={onId} placeholder="kebab-case" />
          {id.length > 0 && !idValid && <div className="text-xs mt-1" style={{ color: 'rgb(var(--red-6))' }}>只能小写字母/数字/横线。</div>}
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>名称</span>
          <Input className="mt-1" value={name} onChange={onName} placeholder="给 Hand 起个名" />
        </label>
      </div>
      <label className="block mt-3">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>分组(可选)</span>
        <Input className="mt-1" value={group} onChange={onGroup} placeholder="e.g. 系统预装" />
      </label>
    </div>
  );
}
