import { Tag } from '@arco-design/web-react';
import type { EntityPickerConfig } from './EntityPicker.js';
import {
  useAgents, useMachines, useHandRecipes, useSkills, useSessions, useModelEntries,
  type Agent, type Machine, type HandRecipe, type RegistrySkill, type SessionSummary,
  type ModelEntry,
} from '../api/queries.js';

// ============================================================
// Per-entity picker configs — the adapters every page reuses
// ============================================================
// One config per entity, declared once. A page that needs "pick an X" imports
// the config and drops in <EntityPicker config={xPickerConfig} …/> or an
// <EntityPickerField/>. Keeps the data source (query hook) and the picker UI in
// sync, and guarantees the same visual everywhere the list appears.

export const agentPickerConfig: EntityPickerConfig<Agent> = {
  useList: useAgents,
  getId: (a) => a.agentId,
  getLabel: (a) => <code className="font-mono text-xs">{a.agentId}</code>,
  getHint: (a) => (a.workerId ? `on ${a.workerId}` : '未分配 worker'),
  getSearchText: (a) => `${a.agentId} ${a.workerId ?? ''}`.toLowerCase(),
  placeholder: '搜索 Agent…',
  emptyText: '还没有 Agent',
};

export const machinePickerConfig: EntityPickerConfig<Machine> = {
  useList: useMachines,
  getId: (m) => m.machineId,
  getLabel: (m) => <code className="font-mono text-xs">🖥 {m.machineId}</code>,
  getHint: (m) => `${m.platform ?? '?'} · ${m.mcpServers.length} MCP · ${m.mcpToolCount} 工具`,
  getBadge: (m) => <Tag size="small" color={m.state === 'active' ? 'green' : undefined}>{m.state}</Tag>,
  getSearchText: (m) => `${m.machineId} ${m.platform ?? ''}`.toLowerCase(),
  placeholder: '搜索机器…',
  emptyText: '还没有接入机器',
};

export const handPickerConfig: EntityPickerConfig<HandRecipe> = {
  useList: useHandRecipes,
  getId: (h) => h.id,
  getLabel: (h) => <span style={{ color: 'var(--color-text-1)' }}>{h.name}</span>,
  getHint: (h) => `🖥 ${h.machineId}`,
  getSearchText: (h) => `${h.id} ${h.name} ${h.machineId}`.toLowerCase(),
  placeholder: '搜索 Hand…',
  emptyText: '还没有 Hand',
};

export const skillPickerConfig: EntityPickerConfig<RegistrySkill> = {
  useList: useSkills,
  getId: (s) => s.name,
  getLabel: (s) => <code className="font-mono text-xs">{s.name}</code>,
  getHint: (s) => s.description,
  getBadge: (s) => (s.builtin ? <Tag size="small">内置</Tag> : null),
  getSearchText: (s) => `${s.name} ${s.description}`.toLowerCase(),
  placeholder: '搜索 Skill…',
  emptyText: '注册表里还没有 Skill',
};

/**
 * Sessions are scoped to one agent, so the config is a factory: pass the
 * agentId, get a picker config bound to that agent's sessions. Used by the
 * wake scheduler to pick a target session after an agent is chosen.
 */
export function sessionPickerConfig(agentId: string | null): EntityPickerConfig<SessionSummary> {
  return {
    useList: () => useSessions(agentId),
    getId: (s) => s.id,
    getLabel: (s) => <code className="font-mono text-xs">{s.id.slice(0, 16)}</code>,
    getHint: (s) => `${s.status}${s.messageCount != null ? ` · ${s.messageCount} 条消息` : ''}`,
    getSearchText: (s) => `${s.id} ${s.title ?? ''}`.toLowerCase(),
    placeholder: '搜索会话…',
    emptyText: '该 Agent 还没有会话',
  };
}

const FAMILY_COLOR: Record<string, string> = { anthropic: 'arcoblue' };

/**
 * The model picker every "pick a model" surface reuses (agent main model,
 * classifier, admin). Lists tiers (L3, `tier:strong`) and concrete models (L2),
 * each badged with its protocol family. Search spans id + family. Pass
 * `disabledFamily`/`isDisabled` (P5) later to grey out cross-family choices.
 */
export const modelPickerConfig: EntityPickerConfig<ModelEntry> = {
  useList: useModelEntries,
  getId: (m) => m.id,
  getLabel: (m) => <code className="font-mono text-xs">{m.label}</code>,
  getHint: (m) => (m.isTier ? `档位 → ${m.target ?? '?'}` : undefined),
  getBadge: (m) => (
    <span className="flex items-center gap-1">
      {m.isTier && <Tag size="small">tier</Tag>}
      {m.family && <Tag size="small" color={FAMILY_COLOR[m.family]}>{m.family}</Tag>}
    </span>
  ),
  getSearchText: (m) => `${m.id} ${m.family ?? ''} ${m.isTier ? 'tier' : ''}`.toLowerCase(),
  placeholder: '搜索模型 / 档位…',
  emptyText: '还没有配置模型 — 去 Models 页创建',
};

/**
 * Family-locked variant of the model picker: when an agent/session is already
 * pinned to a protocol family (anthropic vs openai), cross-family models are
 * greyed out. A session can't mix families — thinking-block signatures are
 * validated per backend, so switching family mid-session would poison history.
 * The runtime guard is the real protection; this is the UI belt. Pass
 * `currentFamily = null/undefined` (e.g. at create time) to impose no lock.
 */
export function modelPickerConfigForFamily(
  currentFamily?: 'anthropic' | 'openai' | null,
): EntityPickerConfig<ModelEntry> {
  if (!currentFamily) return modelPickerConfig;
  return {
    ...modelPickerConfig,
    isDisabled: (m) => m.family != null && m.family !== currentFamily,
    disabledHint: (m) => `${m.family} 模型不能与当前 ${currentFamily} 会话混用`,
  };
}
