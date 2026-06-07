import { useState } from 'react';
import { Table, Card, Button, Modal, Input, Select, Tag, Popconfirm, Message } from '@arco-design/web-react';
import {
  useSkills, useSkillDetail, useRegisterSkill, useDeleteSkill,
  useInstallSkillOnAgent, useAgents,
  type RegistrySkill,
} from '../api/queries.js';
import { PageHeader, ErrorBanner, Spinner, EmptyState } from '../components/Page.js';

// ============================================================
// Skill 市场 — a8s's catalog of installable skills
// ============================================================
// Built-ins ship with a8s; operators may register their own. Installing a
// skill onto an agent forwards its VERBATIM SKILL.md content to the agent's
// home on its owning worker. a8s never rewrites skill content.

export function SkillsPage() {
  const skills = useSkills();
  const del = useDeleteSkill();
  const [detailName, setDetailName] = useState<string | null>(null);
  const [installing, setInstalling] = useState<RegistrySkill | null>(null);
  const [registering, setRegistering] = useState(false);

  if (skills.error) return <ErrorBanner error={skills.error} />;
  if (!skills.data) return <Spinner />;

  const columns = [
    { title: '技能', dataIndex: 'name', render: (v: string) => <code className="font-mono text-xs">{v}</code> },
    {
      title: '说明',
      dataIndex: 'description',
      render: (v: string) => <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{v}</span>,
    },
    {
      title: '来源',
      dataIndex: 'builtin',
      width: 90,
      render: (builtin: boolean) => (builtin ? <Tag size="small">内置</Tag> : <Tag size="small" color="arcoblue">自定义</Tag>),
    },
    {
      title: '操作',
      dataIndex: '__actions',
      align: 'right' as const,
      width: 180,
      render: (_: unknown, s: RegistrySkill) => (
        <div className="flex justify-end gap-1">
          <Button size="mini" type="text" onClick={() => setDetailName(s.name)}>查看</Button>
          <Button size="mini" type="text" onClick={() => setInstalling(s)}>安装到…</Button>
          {!s.builtin && (
            <Popconfirm
              title={`删除技能「${s.name}」?`}
              okText="删除"
              cancelText="取消"
              onOk={() => { void del.mutateAsync(s.name).then(() => Message.success(`已删除 ${s.name}`)); }}
            >
              <Button size="mini" type="text" status="danger">删除</Button>
            </Popconfirm>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Skill 市场"
        subtitle={`${skills.data.length} 个技能 · 选一个装到 agent 上`}
        actions={<Button type="primary" onClick={() => setRegistering(true)}>注册技能</Button>}
      />

      <p className="text-sm -mt-3 mb-4 max-w-3xl" style={{ color: 'var(--color-text-3)' }}>
        技能即知识——一份 <code className="font-mono text-xs mx-1">SKILL.md</code>。把它装到 agent 上,
        a8s 会把<strong>原文</strong>写进该 agent 的 home(由其所在 worker 持有,即唯一事实源);a8s 从不改写技能内容。
        内置技能随 a8s 提供,你也可以注册自己的。
      </p>

      {skills.data.length === 0 ? (
        <EmptyState icon="📘" title="还没有技能" hint="内置技能应随 a8s 提供;也可以点「注册技能」添加自己的。" />
      ) : (
        <Card bordered bodyStyle={{ padding: 0 }}>
          <Table rowKey="name" columns={columns} data={skills.data} pagination={false} size="small" />
        </Card>
      )}

      {detailName && <DetailModal name={detailName} onClose={() => setDetailName(null)} />}
      {installing && (
        <InstallModal
          skill={installing}
          onClose={() => setInstalling(null)}
          onDone={(agentId) => { Message.success(`已把「${installing.name}」装到 agent ${agentId}`); setInstalling(null); }}
        />
      )}
      {registering && (
        <RegisterModal
          onClose={() => setRegistering(false)}
          onDone={(name) => { Message.success(`已注册技能「${name}」`); setRegistering(false); }}
        />
      )}
    </div>
  );
}

function DetailModal({ name, onClose }: { name: string; onClose: () => void }) {
  const detail = useSkillDetail(name);
  return (
    <Modal visible title={<span className="font-mono">{name}</span>} onCancel={onClose} style={{ width: 760 }} footer={<Button onClick={onClose}>关闭</Button>}>
      {detail.error && <ErrorBanner error={detail.error} />}
      {!detail.data ? <Spinner /> : (
        <pre
          className="overflow-auto p-4 rounded-md text-xs font-mono whitespace-pre-wrap"
          style={{ maxHeight: '60vh', background: 'var(--color-fill-2)', color: 'var(--color-text-1)' }}
        >
          {detail.data.content}
        </pre>
      )}
    </Modal>
  );
}

function InstallModal({ skill, onClose, onDone }: {
  skill: RegistrySkill;
  onClose: () => void;
  onDone: (agentId: string) => void;
}) {
  const agents = useAgents();
  const install = useInstallSkillOnAgent();
  const options = (agents.data ?? []).map((a) => a.agentId);
  const [agentId, setAgentId] = useState<string>(options[0] ?? '');
  return (
    <Modal
      visible
      title={`安装「${skill.name}」`}
      onCancel={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={install.isPending}
            disabled={!agentId}
            onClick={async () => { await install.mutateAsync({ agentId, name: skill.name }); onDone(agentId); }}
          >
            安装
          </Button>
        </div>
      }
    >
      {options.length === 0 ? (
        <div className="text-sm" style={{ color: 'rgb(var(--red-6))' }}>还没有 agent。先在「Agents」里创建一个。</div>
      ) : (
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>目标 agent</span>
          <Select className="mt-1" value={agentId} onChange={setAgentId}>
            {options.map((a) => <Select.Option key={a} value={a}>{a}</Select.Option>)}
          </Select>
        </label>
      )}
      {install.error && <div className="text-sm mt-3" style={{ color: 'rgb(var(--red-6))' }}>{install.error instanceof Error ? install.error.message : String(install.error)}</div>}
    </Modal>
  );
}

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const register = useRegisterSkill();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('---\nname: \ndescription: \n---\n\n# \n');
  return (
    <Modal
      visible
      title="注册技能"
      onCancel={onClose}
      style={{ width: 680 }}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={register.isPending}
            disabled={!name || !description || !content}
            onClick={async () => { await register.mutateAsync({ name, description, content }); onDone(name); }}
          >
            注册
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>名称(kebab-case)</span>
          <Input className="mt-1 font-mono" value={name} onChange={setName} placeholder="house-style" />
        </label>
        <label className="block">
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>一句话说明</span>
          <Input className="mt-1" value={description} onChange={setDescription} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>SKILL.md 原文(frontmatter + 正文)</span>
        <Input.TextArea
          className="mt-1 font-mono"
          value={content}
          onChange={setContent}
          style={{ minHeight: 240, fontSize: 12 }}
        />
      </label>
      {register.error && <div className="text-sm mt-2" style={{ color: 'rgb(var(--red-6))' }}>{register.error instanceof Error ? register.error.message : String(register.error)}</div>}
    </Modal>
  );
}
