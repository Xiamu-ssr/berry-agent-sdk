# Cleanup Plan — 2026-04-23

> 先还债再盖楼。v0.5 及以上功能冻结，直到本 plan 完工。
> 作者: 🍓 草莓。review 者: lanxuan（只看大点）。

## 勘察快照

### 实际代码量
- SDK 源码 15,096 行（8 个包，core 占 46%）
- berry-claw 源码 7,233 行（server 2.5k + web 4k）

### 三大问题定位

**P1. 魔法值分布**
- SDK：`core/src/types.ts` 有 11 处事件 type 还是字符串字面量（`'delegate_start'`、`'memory_flushing'` 等），`constants.ts` 只收了一半
- berry-claw server：`'config_changed'` broadcast 字符串散在 8 处
- berry-claw web：`'/api/...'` 路径硬编码在组件里，event.type 字符串在 useWebSocket 里 switch

**P2. 事实源归属混乱**
| 数据 | 现状 | 应归属 |
|:---|:---|:---|
| Agent `entry.model` | SDK config + 前端 useState(currentModel) 双写 | **SDK 唯一** |
| Agent `status`（idle/working） | SDK AgentManager 持有 | ✓ SDK |
| Team / worklist / messages | SDK @berry-agent/team 持有 | ✓ SDK |
| Session 列表 / 当前 session | SDK SessionStore | ✓ SDK |
| Provider instances / credentials | SDK ConfigManager | ✓ SDK |
| Active tab（chat/agents/...） | 前端 useState | ✓ 前端 — 是 UI 状态 |
| Form 输入、弹窗开合、折叠态 | 前端 useState | ✓ 前端 — 是 UI 状态 |
| WebSocket 订阅列表 | 前端 hook | ✓ 前端 — 是 UI 状态 |

**核心问题**：SDK 给外部的接口是 **"一堆 REST 端点 + WS 事件碎片"**，而不是 **"权威快照 + 变更流"**。前端被迫自己拼状态。

**P3. 前端布局 / 可视化**
- Chat 页 `w-56` 左栏高度利用 <30%，里面只有 AgentSelector（含当前 agent 卡片 + model 下拉）+ Compact 按钮
- Agents 页：表格 + 弹窗编辑，纯文字
- Teams 页：3 栏文字（成员 / worklist / 消息），拓扑关系不可见
- 色调：berry 色系 OK，但缺层次（全是 gray-50/800 + berry-600）

## 修复计划（按执行顺序）

### Phase 0：基础设施（0.5h）
- [x] 起 dev server + 截图 4 张 ✓（shots/01-04）
- [ ] 本 plan 文件入 git

### Phase 1：SDK 魔法值收口（2-3h）
**目标**：event type / status / tool name / error kind 都有唯一事实源

- [ ] core/src/constants.ts 合并 event-log/constants.ts，扩充到覆盖：
  - `AgentEventType`（所有 event.type）
  - `AgentStatusValue`（所有 agent.status）
  - `ErrorKind`（classifyError 的返回值）
  - `CrashKind` / `ToolCallStatus`（已有）
- [ ] types.ts 里的 AgentEvent union 从 constants 派生 type，而不是字符串字面量
- [ ] core + observe + team 里 grep 出所有字符串字面量 → 引用 constants
- [ ] berry-claw server 的 `'config_changed'`、`'session_compacted'` broadcast → SDK 导出 `WS_EVENT` 常量
- [ ] berry-claw web 的 `/api/*` 路径 → 生成一个 `src/api/paths.ts` 单一来源
- [ ] berry-claw web 的 WebSocket msg.type switch → 用 SDK 导出的 discriminated union

**验收**：grep 全仓字符串字面量 = 0（除 test 外）

### Phase 2：SDK Fact 协议（4-6h，**大点，先和 lanxuan 过**）
**目标**：SDK 对外暴露三类只读 fact + 一条变更流

```ts
// @berry-agent/core 新增 facts.ts
export interface AgentFact {
  id: string;
  name: string;
  model: string;            // 唯一事实源
  provider: string;
  workspace: string;
  project?: string;
  status: AgentStatusValue;
  currentSessionId?: string;
  lastActivityAt?: number;
}

export interface TeamFact {
  id: string;
  name: string;
  project: string;
  leaderId: string;
  teammates: Array<{ agentId: string; role: string }>;
  worklist: WorkItem[];
  messageCount: number;
}

export interface SessionFact {
  id: string;
  agentId: string;
  messageCount: number;
  turnCount: number;
  tokensUsed: number;
  compactionCount: number;
  crashRecovered: boolean;
  lastCompactionAt?: number;
}
```

- [ ] 定义 `FactStore` 接口 + `subscribeFacts(predicate)` API
- [ ] AgentManager / TeamStore / SessionStore 实现 fact 派生
- [ ] WS 层只 push `fact_changed { kind, id, fact }`（替代 config_changed / session_* 零散事件）
- [ ] berry-claw server 层删掉本地状态缓存，改 pass-through
- [ ] AgentsPage + AgentSelector 订阅同一个 fact，model 双写问题自动消失

**要 review 的决策**：
- fact 是 pull（REST `/api/facts/agents`）还是 push（WS 增量）还是混合？→ 我倾向**混合：REST 拉初始全量，WS 推增量**，前端靠 id 做 merge
- fact 粒度：要不要把 `messages[]` 也放进 SessionFact？→ 倾向**不放**，消息数据量大，单独走 `/api/sessions/:id/messages` + WS stream

### Phase 3：berry-claw server pass-through 化（2h）
- [ ] 删除 server.ts 里所有"收到 PUT /agents 之后手动 broadcast config_changed"的胶水代码
- [ ] 所有写操作路由直达 SDK，变更流由 SDK FactStore 自动吐
- [ ] useWebSocket 只监听 `fact_changed`，不再有 10 种事件类型分支
- [ ] 删 `hydrateChatMessages` 的冗余逻辑（如果 SDK 输出的 ChatMessage 已经规范）

### Phase 4：Chat 页布局重做（2-3h）
- [ ] 删 `w-56` 左栏，agent selector + compact 上提到顶栏
- [ ] 顶栏重构：`[🍊 Agent ▼] [Model ▼] [Compact] [Status]` 一排，剩余宽度全给消息
- [ ] 消息区 max-width 改 64rem（减少超宽屏时行长过度）
- [ ] ToolCallCard / CodeBlock 紧凑模式（目前 padding 过大）

### Phase 5：Agents / Teams 图可视化（4-6h）
**选型**：React Flow（TS-native、体积 50kb、shadcn 兼容好）

- [ ] 装 `reactflow`
- [ ] Agents 页：每个 agent 一个节点，连到 project 节点和 workspace 节点；边上标 model；色彩 = status
- [ ] Teams 页：leader 中心节点，teammate 环绕，worklist item 作为浮动卡片，消息动画
- [ ] 保留右侧详情抽屉（点节点看详细字段 + 编辑）

### Phase 6：视觉统一（2h）
- [ ] 引入 shadcn/ui 的 5 个核心组件：Button / Dialog / Dropdown / Tabs / Badge
- [ ] 统一 border/shadow/radius token
- [ ] 空状态插画（至少一个 🍓 吉祥物）

## 时间预算

| Phase | 工时 | 累计 |
|:---|---:|---:|
| 1 魔法值 | 2-3h | 3h |
| 2 Fact 协议 | 4-6h | 9h |
| 3 berry-claw server | 2h | 11h |
| 4 Chat 布局 | 2-3h | 14h |
| 5 图可视化 | 4-6h | 20h |
| 6 视觉 | 2h | 22h |

约 3 天满负荷。分 3 次 commit wave：
- **Wave A** = Phase 1 + 2 + 3（SDK + server 清理，一次发 v2.0-alpha.2）
- **Wave B** = Phase 4（chat 布局）
- **Wave C** = Phase 5 + 6（可视化 + 视觉）

## 不做的

- 不引入新状态管理库（zustand/redux 都不要，现有 useState + fact 订阅够用）
- 不做 i18n
- 不动 observe UI（已经够用，只做深色一致性）
- 不做移动端精修（桌面优先）

## Review 点（需要 lanxuan 拍板）

1. **Phase 2 的 FactStore 是不是过度设计？** → 如果你觉得"直接在现有 REST + WS 上打补丁"够用，就跳过 Phase 2/3 的架构重构，只做 Phase 1 + 4 + 5。我的判断：不做 Phase 2，双写问题治标不治本。
2. **React Flow 可以吗？** → 或者你更想要一个"社交卡片墙"（没有边、只有卡片 + hover 连线），这偏视觉。
3. **v2.0-alpha.2 发 npm 放在 Wave A 结束还是全部完工？**

其他实现细节我自己拍。
