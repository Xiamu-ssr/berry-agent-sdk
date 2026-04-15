# Berry Agent SDK — v0.3 Plan

> 基于 2026-04-15 lanxuan + 草莓🍓 的架构讨论
> 参考文章：Managed Agents (Anthropic), The Loop Is the Lab, Claude Code Auto Mode

---

## 核心理念

**v0.1** 解决了 "怎么让 agent 跑起来"（agent loop + tools + providers）
**v0.2** 解决了 "怎么看 agent 在做什么"（observe + turn + guard audit）
**v0.3** 解决了 "怎么让 agent 记住和成长"（event log + agent identity + project context）

---

## 架构图（v0.3 目标）

```
┌─────────────────────────────────────────────────────────────┐
│                      Berry Agent SDK                         │
│                                                              │
│  ┌──────────────────────── core ──────────────────────────┐  │
│  │                                                        │  │
│  │  Agent                                                 │  │
│  │  ├── identity: { id, systemPrompt, workspace }         │  │
│  │  ├── memory: AgentMemory (per-agent 长期记忆)          │  │
│  │  ├── project?: ProjectContext (可选绑定)                │  │
│  │  │                                                     │  │
│  │  ├── Session Event Log (append-only)                   │  │
│  │  │   ├── user_message                                  │  │
│  │  │   ├── assistant_message                             │  │
│  │  │   ├── tool_use { name, input }                      │  │
│  │  │   ├── tool_result { content, isError }              │  │
│  │  │   ├── thinking                                      │  │
│  │  │   ├── query_start / query_end                       │  │
│  │  │   ├── compaction_marker                             │  │
│  │  │   ├── guard_decision                                │  │
│  │  │   └── delegate_start / delegate_end                 │  │
│  │  │                                                     │  │
│  │  └── Context Window (Event Log 的派生视图)             │  │
│  │      └── buildContextWindow(eventLog, strategy)        │  │
│  │                                                        │  │
│  │  Provider (Anthropic / OpenAI)                         │  │
│  │  ProviderRegistry (multi-provider routing)             │  │
│  │  Compaction (只影响 Context Window，不动 Event Log)    │  │
│  │  Skills / delegate / spawn                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─── observe ───┐  ┌─── safe ───┐  ┌─── mcp ───┐          │
│  │ Collector      │  │ Guards     │  │ MCPClient  │          │
│  │ (记账本)       │  │ Classifier │  │ Adapter    │          │
│  │ ↓              │  │ PI Probe   │  └────────────┘          │
│  │ Analyzer       │  │ Audit      │                          │
│  │ (仪表盘)       │  └────────────┘  ┌─── tools-common ───┐  │
│  │ ↓              │                  │ file/shell/web/     │  │
│  │ REST API + UI  │                  │ browser/search      │  │
│  └────────────────┘                  └────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Session Event Log（core 包改造）

**目标**：messages[] → append-only event log + context window 视图

### 1.1 EventLog 数据结构

```typescript
// --- Event Types ---

interface BaseEvent {
  id: string;           // nanoid
  timestamp: number;    // Date.now()
  turnId?: string;      // 所属 Turn (query_start → query_end 周期)
  sessionId: string;
}

// Berry 格式的完整事件（包含 tool calling 参数和 tool output）
type SessionEvent =
  | BaseEvent & { type: 'user_message'; content: string | ContentBlock[] }
  | BaseEvent & { type: 'assistant_message'; content: ContentBlock[] }
  | BaseEvent & { type: 'tool_use'; name: string; toolUseId: string; input: Record<string, unknown> }
  | BaseEvent & { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | BaseEvent & { type: 'thinking'; thinking: string }
  | BaseEvent & { type: 'query_start'; prompt: string }
  | BaseEvent & { type: 'query_end'; result: QueryResult }
  | BaseEvent & { type: 'compaction_marker'; strategy: string; tokensFreed: number }
  | BaseEvent & { type: 'guard_decision'; toolName: string; decision: ToolGuardDecision }
  | BaseEvent & { type: 'delegate_start'; message: string }
  | BaseEvent & { type: 'delegate_end'; result: DelegateResult }
  | BaseEvent & { type: 'api_call'; model: string; inputTokens: number; outputTokens: number }
  | BaseEvent & { type: 'metadata'; key: string; value: unknown };  // 扩展点
```

### 1.2 EventLogStore 接口

```typescript
interface EventLogStore {
  /** 追加事件（永不修改已有事件） */
  append(sessionId: string, event: SessionEvent): Promise<void>;

  /** 批量追加 */
  appendBatch(sessionId: string, events: SessionEvent[]): Promise<void>;

  /** 读取事件（支持范围查询） */
  getEvents(sessionId: string, options?: {
    from?: number;    // 起始 index
    to?: number;      // 结束 index
    since?: number;   // 时间戳过滤
    types?: string[]; // 事件类型过滤
  }): Promise<SessionEvent[]>;

  /** 获取事件总数 */
  count(sessionId: string): Promise<number>;

  /** 列出所有 session */
  listSessions(): Promise<string[]>;
}
```

### 1.3 默认实现：JSONL 文件

```
{agent_workspace}/.berry/sessions/
  ├── ses_abc123.jsonl      ← 每行一个 JSON 事件，append-only
  ├── ses_def456.jsonl
  └── index.json            ← session 元数据索引
```

选 JSONL 的理由：
- 追加写入天然原子（一行一写）
- 人类可读，grep 友好
- 崩溃恢复简单（最后一行可能不完整，截断即可）
- 不需要额外依赖（不用 SQLite）

### 1.4 Context Window Builder

```typescript
interface ContextStrategy {
  /** 从 Event Log 构建 messages[] 给 Provider */
  buildMessages(events: SessionEvent[]): Message[];
}

// 默认策略：重放所有 message 类事件，跳过 compaction_marker 之前的
class DefaultContextStrategy implements ContextStrategy {
  buildMessages(events: SessionEvent[]): Message[] {
    // 1. 找最后一个 compaction_marker
    // 2. 从 marker 之后开始构建 messages[]
    // 3. 跳过 metadata/api_call 等非对话事件
    // 4. 合并相邻同 role 消息
  }
}
```

### 1.5 Agent 改造

当前 agent.ts 中的 `query()` 方法：
- 现在：直接操作 `session.messages[]`
- 改后：每个 action 先 `append()` 到 event log，context window 按需重建

```typescript
// 伪代码
async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
  // 1. append user_message event
  await this.eventLog.append(sessionId, { type: 'user_message', content: prompt });

  // 2. build context window from event log
  const events = await this.eventLog.getEvents(sessionId);
  const messages = this.contextStrategy.buildMessages(events);

  // 3. agent loop（跟现在一样，但每个 step 都 append event）
  while (...) {
    const response = await this.provider.chat({ systemPrompt, messages, tools });
    await this.eventLog.append(sessionId, { type: 'assistant_message', content: response.content });

    for (const toolCall of toolCalls) {
      await this.eventLog.append(sessionId, { type: 'tool_use', ... });
      const result = await executeTool(toolCall);
      await this.eventLog.append(sessionId, { type: 'tool_result', ... });
      messages.push(...); // context window 更新
    }
  }

  // 4. compaction 只改 context strategy，不动 event log
  if (shouldCompact) {
    const compacted = await compact(messages);
    await this.eventLog.append(sessionId, { type: 'compaction_marker', ... });
    // context window 被替换，但 event log 完整保留
  }
}
```

### 1.6 向后兼容

- `SessionStore` 接口保留（deprecated），内部代理到 `EventLogStore`
- `session.messages` 依然可用，变成 context window 的快照
- 旧的 JSON session 文件可以一次性迁移为 JSONL event log

### 1.7 Observe 集成

Event Log 建立后，observe 的 collector 可以选择性地从 event log 读取数据做关联分析：
- "这个 Turn 的 tool_result 全文是什么？"（现在 observe 不存 tool result 全文）
- "compaction 之前的原始对话是什么？"（可以回溯）

但 observe 不依赖 event log——它依然通过 middleware 独立采集 wire format 数据。两者是互补的。

---

## Phase 2: Agent Identity & Workspace（core 包扩展）

**目标**：Agent 从"一个函数调用"升级为"一个有身份、有工作区的实体"

### 2.1 Agent Workspace

```
{workspace_root}/
  ├── agent.json              ← agent 元数据（id, name, systemPrompt ref, model）
  ├── AGENT.md                ← system prompt（可编辑，类似 CLAUDE.md）
  ├── MEMORY.md               ← agent 长期记忆（agent 自己写）
  ├── .berry/
  │   ├── sessions/           ← JSONL event logs
  │   └── state.json          ← 运行时状态
  └── tools/                  ← agent 专属工具（可选）
```

每个 Agent 有独立的 workspace 目录。Agent 之间数据隔离。

### 2.2 Agent Memory

```typescript
interface AgentMemory {
  /** 读取记忆 */
  load(): Promise<string>;
  /** 追加记忆 */
  append(content: string): Promise<void>;
  /** 搜索记忆（语义或全文） */
  search(query: string): Promise<MemoryResult[]>;
}

// 默认实现：Markdown 文件
class FileAgentMemory implements AgentMemory {
  constructor(private memoryPath: string) {} // → MEMORY.md
}
```

Agent Memory 存的是 agent 级别的个人成长：
- "我容易忘记 error handling"
- "用户喜欢简洁的回答"
- "这个 API 的 rate limit 是 60/min"

### 2.3 Project Context（可选绑定）

```typescript
interface ProjectContext {
  /** 项目根目录 */
  root: string;
  /** 读取项目上下文文件 */
  loadContext(): Promise<string>;  // → 读 AGENTS.md / PROJECT.md 等
  /** 写入项目发现 */
  appendDiscovery(content: string): Promise<void>;
  /** 搜索项目知识 */
  search(query: string): Promise<MemoryResult[]>;
}
```

Project Context 存的是项目级别的共享知识：
- "这个项目用 Tailwind 3 不是 4"
- "API 端点约定：/api/v1/ 前缀"
- "测试用 Vitest，不用 Jest"

一个 Agent 可以绑定到 0 或 1 个 Project。绑定后，Agent 在 session 中同时能看到自己的 workspace 和 project 的文件。

```typescript
const coder = Agent.create({
  workspace: '/agents/coder',       // agent 自己的家
  project: '/projects/berry-claw',  // 可选绑定
  ...
});
```

---

## Phase 3: Observe 分层清晰化（observe 包重构）

**目标**：记账本和仪表盘明确分离

### 3.1 目录重组

```
observe/src/
  ├── collector/              ← 记账本（数据采集层）
  │   ├── schema.ts           ← 表结构
  │   ├── db.ts               ← 数据库初始化 + 迁移
  │   ├── collector.ts        ← createCollector() 工厂
  │   ├── pricing.ts          ← 成本计算
  │   └── retention.ts        ← 数据保留策略
  │
  ├── analyzer/               ← 仪表盘（数据分析层）
  │   ├── analyzer.ts         ← 查询 + 聚合（只通过 SQL 读 db）
  │   ├── metrics.ts          ← 派生指标计算（成功率、重试率等）
  │   └── api-types.ts        ← API 类型定义
  │
  ├── server.ts               ← REST API（调用 analyzer）
  ├── observer.ts             ← createObserver() 工厂（组装 collector + analyzer）
  ├── standalone.ts           ← 独立启动服务
  └── index.ts                ← 公共导出
```

### 3.2 新增 metrics.ts（主动分析）

```typescript
// 从 raw 数据派生的指标
interface TurnMetrics {
  toolSuccessRate: number;   // tool_result.isError === false 的比例
  retryCount: number;        // 同一 tool 连续调用次数
  costEfficiency: number;    // output_tokens / total_cost
  guardDenyRate: number;     // guard deny / total guard decisions
  avgLatencyMs: number;      // 平均 API call 延迟
}

interface SessionMetrics {
  turnsCount: number;
  totalCost: number;
  compactionCount: number;
  toolDistribution: Record<string, number>;  // 各 tool 使用次数
}
```

这是"仪表盘"的增量改进，不急着做，放在 Phase 3。

---

## Phase 4: Berry-Claw 升级（产品层）

> 这部分在 berry-claw 仓库规划，不在 SDK 里

### 4.1 Agent Workspace UI
- Agent 管理页面展示 workspace 目录结构
- AGENT.md / MEMORY.md 在线编辑
- Agent 创建时自动初始化 workspace

### 4.2 Task Mode（编排能力）
- Task 定义：Pipeline（有序步骤）
- 每个步骤分配一个 Agent + prompt
- Session 级别追踪（每步一个 session）
- Task 结束后，session 数据选择性回流到 Agent Memory / Project Context

### 4.3 Observe 增强
- 跨 Agent 视图（"这个 Project 的所有 agent 总共花了多少钱"）
- Dark mode 适配（SDK UI 组件需要支持主题变量）

---

## 优先级排序

| 优先级 | 内容 | 包 | 预估工作量 |
|---|---|---|---|
| **P0** | Session Event Log (JSONL store + context builder) | core | 大（agent.ts 重构） |
| **P0** | EventLogStore 接口 + FileEventLogStore 实现 | core | 中 |
| **P0** | 向后兼容：旧 SessionStore → EventLogStore 迁移 | core | 中 |
| **P1** | Agent Workspace 目录规范 | core | 小 |
| **P1** | Agent Memory 接口 + FileAgentMemory | core | 小 |
| **P1** | Project Context 接口 + 基础实现 | core | 小 |
| **P1** | Observe 记账本/仪表盘目录分离 | observe | 小（重组文件，不改逻辑） |
| **P2** | Observe metrics.ts（派生指标） | observe | 中 |
| **P2** | Berry-Claw Task Mode | berry-claw | 大 |
| **P2** | Observe dark mode 主题支持 | observe | 小 |
| **P3** | Event Log → diary 自动摘要 | core or 新包 | 中 |
| **P3** | Event Log → memory_search 集成 | core | 中 |

---

## 不做的事（明确排除）

- ❌ 不把 Event Log 放在 observe 包里（Event Log 是 core 概念）
- ❌ 不做 Event Log 的 wire format 存储（那是 observe 的职责）
- ❌ 不合并 observe.db 和 event log 存储（两个不同关注点）
- ❌ 不在 v0.3 做 multi-agent orchestration protocol（先做好单 agent 基础）
- ❌ 不做自动 memory distillation（v0.3 只提供接口，具体策略留给消费者或 v0.4）

---

## 代码质量规则（所有 CC 任务必须遵守）

1. 删除 deprecated code，不保留兼容 wrapper（除非有明确迁移期）
2. 重构接口时同步更新所有调用方
3. 不留 TODO/FIXME 除非附带 issue 编号
4. 新代码禁止 `any`，遇到旧 `any` 也要修
5. 所有公共接口写 JSDoc
6. 测试覆盖：新接口必须有单元测试
7. 每个 Phase 完成后跑 `tsc --noEmit` + `vitest run` + 人工 review

---

## 设计决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| Event Log 归属 | core 包 | 是 agent 运行的主数据结构，不是旁路分析 |
| Event Log 存储格式 | JSONL 文件 | 追加友好、人类可读、零依赖 |
| Event Log 内容 | Berry 格式（含 tool call/result 全文） | 最底层行为日志，wire format 留给 observe |
| Context Window 来源 | 从 Event Log 派生 | compaction 不可逆丢信息 → 需要原始记录 |
| Agent 与 Project 关系 | 可选绑定（0 or 1） | Agent 独立存在，Project 是增强 |
| 回流分层 | Agent Memory + Project Context | 个人成长 vs 项目知识，不同作用域 |
| Observe 内部分层 | collector（记账本）+ analyzer（仪表盘） | 采集和分析关注点分离 |
