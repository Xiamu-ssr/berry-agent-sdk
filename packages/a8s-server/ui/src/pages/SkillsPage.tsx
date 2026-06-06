import { useState } from 'react';
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
  const [flash, setFlash] = useState<string | null>(null);

  if (skills.error) return <ErrorBanner error={skills.error} />;
  if (!skills.data) return <Spinner />;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Skill 市场"
        subtitle={`${skills.data.length} 个技能 · 选一个装到 agent 上`}
        actions={<button type="button" className="btn btn-primary" onClick={() => setRegistering(true)}>注册技能</button>}
      />

      <p className="text-sm text-ink-500 dark:text-ink-400 -mt-3 mb-4 max-w-3xl">
        技能即知识——一份 <code className="font-mono text-xs mx-1">SKILL.md</code>。把它装到 agent 上,
        a8s 会把<strong>原文</strong>写进该 agent 的 home(由其所在 worker 持有,即唯一事实源);a8s 从不改写技能内容。
        内置技能随 a8s 提供,你也可以注册自己的。
      </p>

      {flash && (
        <div className="card mb-4 border-snow-300 bg-snow-50 dark:border-snow-900 dark:bg-snow-950/30 text-snow-700 dark:text-snow-300 text-sm">
          {flash}
        </div>
      )}

      {skills.data.length === 0 ? (
        <EmptyState icon="📘" title="还没有技能" hint="内置技能应随 a8s 提供;也可以点「注册技能」添加自己的。" />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">技能</th>
                <th className="table-head">说明</th>
                <th className="table-head">来源</th>
                <th className="table-head text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {skills.data.map((s) => (
                <tr key={s.name} className="hover:bg-ink-50 dark:hover:bg-ink-900/50">
                  <td className="table-cell font-mono text-xs">{s.name}</td>
                  <td className="table-cell text-ink-500 dark:text-ink-400 text-xs max-w-md">{s.description}</td>
                  <td className="table-cell">
                    {s.builtin ? <span className="pill pill-muted text-[10px]">内置</span> : <span className="pill pill-info text-[10px]">自定义</span>}
                  </td>
                  <td className="table-cell text-right whitespace-nowrap">
                    <button className="btn btn-ghost text-xs" onClick={() => setDetailName(s.name)}>查看</button>
                    <button className="btn btn-ghost text-xs text-snow-700" onClick={() => setInstalling(s)}>安装到…</button>
                    {!s.builtin && (
                      <button className="btn btn-ghost text-xs text-berry-600" onClick={() => { void del.mutateAsync(s.name); }}>删除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailName && <DetailModal name={detailName} onClose={() => setDetailName(null)} />}
      {installing && (
        <InstallModal
          skill={installing}
          onClose={() => setInstalling(null)}
          onDone={(agentId) => { setFlash(`已把「${installing.name}」装到 agent ${agentId}`); setInstalling(null); }}
        />
      )}
      {registering && (
        <RegisterModal
          onClose={() => setRegistering(false)}
          onDone={(name) => { setFlash(`已注册技能「${name}」`); setRegistering(false); }}
        />
      )}
    </div>
  );
}

function DetailModal({ name, onClose }: { name: string; onClose: () => void }) {
  const detail = useSkillDetail(name);
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold font-mono">{name}</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        {detail.error && <ErrorBanner error={detail.error} />}
        {!detail.data ? <Spinner /> : (
          <pre className="flex-1 overflow-auto bg-ink-950 text-ink-100 p-4 rounded-md text-xs font-mono whitespace-pre-wrap">
            {detail.data.content}
          </pre>
        )}
      </div>
    </div>
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
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-md">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">安装「{skill.name}」</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        {options.length === 0 ? (
          <div className="text-sm text-berry-600 dark:text-berry-400 mb-3">还没有 agent。先在「Agents」里创建一个。</div>
        ) : (
          <label className="block mb-3">
            <span className="text-xs text-ink-500">目标 agent</span>
            <select className="input mt-1 w-full" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {options.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        )}
        {install.error && <div className="text-sm text-berry-600 mb-3">{install.error instanceof Error ? install.error.message : String(install.error)}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={install.isPending || !agentId}
            onClick={async () => { await install.mutateAsync({ agentId, name: skill.name }); onDone(agentId); }}
          >
            {install.isPending ? '安装中…' : '安装'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RegisterModal({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const register = useRegisterSkill();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('---\nname: \ndescription: \n---\n\n# \n');
  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center p-4 z-20">
      <div className="card w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">注册技能</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="text-xs text-ink-500">名称(kebab-case)</span>
            <input className="input mt-1 w-full font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="house-style" />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">一句话说明</span>
            <input className="input mt-1 w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <label className="block flex-1 flex flex-col min-h-0">
          <span className="text-xs text-ink-500">SKILL.md 原文(frontmatter + 正文)</span>
          <textarea
            className="input mt-1 w-full flex-1 font-mono text-xs min-h-[240px]"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        {register.error && <div className="text-sm text-berry-600 mt-2">{register.error instanceof Error ? register.error.message : String(register.error)}</div>}
        <div className="flex justify-end gap-2 mt-3">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={register.isPending || !name || !description || !content}
            onClick={async () => { await register.mutateAsync({ name, description, content }); onDone(name); }}
          >
            {register.isPending ? '注册中…' : '注册'}
          </button>
        </div>
      </div>
    </div>
  );
}
