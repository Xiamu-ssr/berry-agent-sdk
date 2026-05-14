# 编码规范
1. 不做缓存
2. 魔法值和常量,统一在一个文件维护。善用枚举
3. 涉及序列化和反序列化可能丢失事实时,遵守唯一事实源,比如后端和数据库交互以数据表类为事实且不写raw sql、比如前后端数据传输以后端实体类为事实且前端实体类用脚本从后端生成。

# AGENTS.md — Berry Agent SDK 总览

设计对齐文档。讲清楚这个 SDK 的形状、磁盘布局、各模块职责边界。写给集成方 / 维护者看,假定读者已有 agent 基础概念。

**核心信条**:**Agent = 一组文件**。内存是文件的缓存,不是事实。进程随时可死,文件一直在。

---

## 一句话

Berry Agent SDK 是一个构建长期运行、可恢复、可热切换的 AI Agent 的 TypeScript 库。所有可变状态(context、配置、记忆)都以文件为唯一事实源。进程崩了读文件即恢复,配置改了下次 LLM 调用生效。

---

## 术语对齐

| 术语 | 含义 |
|---|---|
| **一次 LLM 推理** | `provider.chat(...)` 调用一次,入 messages + system + tools,出一段 assistant 内容(可能含 tool_use block) |
| **一个 turn** | Agent 从接到一条 user message / interject 开始,循环"LLM 推理 → 若有 tool_use 就执行 tool → 把 tool_result 塞回 messages 再问 LLM"直到 `stopReason=end_turn` 为止。**一个 turn 通常包含多次 LLM 推理**。每次 LLM 推理前都会先把当前 messages 原子写入 messages.json,再读回作为 provider 入参 |
| **session** | 一串连续的 turn,共享 `<root>/sessions/<sid>/` 目录。LLM 看到的 messages 跨 turn 持续累积(可能被 compact 重写) |
| **delegate** | 在当前 turn 内部起一个 transient session 跑子任务。delegate **就是一个独立的小 turn**(内部照样多次 LLM 推理 + tool),只是共享父 cache 前缀、跑完丢弃、不进 messages.json |
| **compact** | 重写 messages.json:把老消息压成摘要 + 保留近期消息。触发可能在 turn 末尾(自动按 token 阈值),也可能宿主手动调 `compact()` |
| **agent 实例** | 进程内 `new Agent({ rootDir })` 构造出的对象。拥有 MCP 子进程、provider 实例 等进程资源。`close()` 释放这些资源,实例即不可用 |
| **agent 身份** | `<root>/` 这个目录。只要目录在,就可以在任何新进程 `new Agent({ rootDir })` 复活,跟之前的实例"是同一个 agent"。真·删除 = `rm -rf <root>` |

---

## 生命周期

### 状态机(进程内实例)

```
idle ⇄ tool_use
idle ⇄ sleeping
```

- **idle** — 等输入
- **tool_use** — 正在跑 turn(含 LLM 推理、tool 执行、delegate 子 turn)
- **sleeping** — `sleep` 工具主动休眠;`interject()` 或超时唤醒

这三态覆盖**进程内实例的存活期**。

### 实例 vs 身份

| 层级 | 载体 | 生死 |
|---|---|---|
| **进程内实例** | `new Agent({ rootDir })` 构造的对象 | `close()` 释放进程资源:SIGTERM 所有 MCP 子进程、join 在跑的 tool、关文件句柄。实例即废,不提供"复活"方法 |
| **agent 身份** | `<root>/` 目录 | 只要目录在,就可以在任何新进程构造新实例指向它,MCP 从 `.mcp.json` 重新拉起、session 从 messages.json 继续。真·删除 = `rm -rf <root>` |

**参考 Claude Code / Codex 做法**:MCP 子进程绑定 CLI 进程生命周期,进程退出 → 所有 MCP 子进程 SIGTERM。没有"实例复活"概念——`claude --resume <id>` 也是新进程、新 MCP 子进程,只是从 session 文件继续 context。Berry 沿用此语义。

### 核心能力

| 分组 | 方法 | 说明 |
|---|---|---|
| 构造 / 关闭 | `new Agent({ rootDir })` / `close()` | 从目录装配实例 / 释放进程资源(不删目录) |
| 会话交互 | `send()` / `interject()` | `send` 单一入口,塞消息跑一个 turn;`interject` 运行中插话,汇入下一轮 LLM 推理 |
| 分身 | `delegate()` | 跑一个 transient session 的独立 turn,共享父 cache 前缀,结果合回父 tool_result,transient session 丢弃 |
| 热切换 | `switchModel()` / `addTool()` | 改 `agent.json`,下次 LLM 推理前从 models 包重建 provider |
| 内省 | `snapshot()` / `getTools()` / `getMCP()` / `getSkillMetas()` / `listSessions()` / `getTodos()` | 只读 |
| 持久化 | session 自动落盘(每 turn 末);`compact()` 手动压缩 context | 事实在磁盘,方法只是触发器 |

多 Agent 协同(spawn 持久子 agent)不在 core,归 `@berry-agent/team` 的 `spawn_teammate` 工具管。

---

## 运行时目录

```
<root>/
├── agent.json                      # 可切换配置的唯一事实源(不含 systemPrompt)
├── AGENTS.md                       # per-agent 静态 system prompt
├── MEMORY.md                       # 长期记忆主索引
├── memory/                         # 按主题拆的记忆片段
│   └── *.md
├── .mcp.json                       # per-agent MCP 配置
├── skills/                         # per-agent skill 池
│   └── <skill-name>/
│       └── SKILL.md
└── sessions/
    └── <sessionId>/
        ├── messages.json           # 当前 LLM 眼里的 context(可被 compact 重写)
        └── events.jsonl            # 完整原始操作历史(append-only,永不重写)
```

宿主选 `root`(如 `~/.berry-claw/agents/<id>/` 或 `./my-agent`)。SDK 决定每个子路径。

**project 级共享资源**(跨 agent):由宿主指定一个"项目目录",SDK 约定**只有一份**文件:

```
<projectDir>/
└── AGENTS.md                       # 项目级指令 / 背景(人类维护,agent 只读)
```

Claude Code / Codex / OpenAI 约定一致——project 级知识是**团队共有**的,由人类维护,agent 单方面写入会污染协作,不做 `.berry-discoveries.md` 这类"agent 写项目级"的设计。agent 发现值得团队知道的东西 → 建议改 AGENTS.md 让人 review,或写进自己的 per-agent MEMORY.md。

---

## 两层配置

配置按"生命周期"分两层:

| 层 | 文件 | 粒度 | 内容 |
|---|---|---|---|
| **agent 级** | `<root>/agent.json` | per-agent | 只有"这个 agent 用什么 model / tool / compact 策略"等 agent 身份相关 |
| **SDK 级** | 宿主必传的 `sdkConfigPath`(SDK 不提供默认值,跟 `rootDir` 一样) | 跨 agent | 凭证 / tier 定义 / web 工具密钥 / classifier 模型 等**不属于某个 agent** 的设定 |

### agent.json — agent 身份事实源

```jsonc
{
  "id": "...",
  "name": "...",
  "createdAt": "2026-05-09T00:00:00.000Z",
  "model": "tier:strong",                      // 或 "model:claude-opus-4-6" / 裸 model id
  "reasoningEffort": "medium",                 // 可选: none | low | medium | high | max
  "toolDenylist": ["web_search", "process_kill"], // 黑名单: 这些 tool 一律拒绝
  "compaction": { "contextWindow": 200000, "threshold": 170000, /* ... */ },
  "skills": { "extraDirs": ["..."] },
  "mcp": { "extraPaths": ["..."] }
}
```

**只存 model 引用字符串**,由 `@berry-agent/models` 的 `selectProvider()` 解析成运行时 provider + 凭证(凭证走 SDK 级配置,见下)。core 不认 ProviderConfig 细节,只认"给我一个能跑的 Provider 实例"。

**不在里面**:`systemPrompt`(走 AGENTS.md)、运行时 env(进程级)、tool execute 函数(是代码)、API key(走 SDK 级配置)。

**`switchModel(modelRef)` 的语义**:改 `agent.json.model`。下次 LLM 推理前 agent 读 agent.json、让 models 包按新 ref 返回 provider。没有 `switchProvider()`——provider 是 models 包的内部概念,对外只暴露 model 字符串。

**`setReasoningEffort(effort)` 的语义**:改 `agent.json.reasoningEffort`。下次 LLM 推理生效。与 model 独立,不触发 provider 重建。

### SDK 级配置 — 跨 agent 共用的东西

宿主**必须**在启动时显式传 `sdkConfigPath`(SDK 不做任何默认路径回退——跟 `rootDir` 一样,SDK 不替宿主决定文件该放哪)。结构上**每个包有自己的 namespace**,互不越界:

```jsonc
{
  "models": {
    "providers": {
      "anthropic": { "presetId": "anthropic_official", "apiKey": "sk-..." },
      "openai":    { "presetId": "openai_official", "apiKey": "sk-..." }
    },
    "models": {
      "claude-opus-4-6": { "providers": [{ "providerId": "anthropic" }] },
      "claude-sonnet-4-6": { "providers": [{ "providerId": "anthropic" }] },
      "gpt-4o": { "providers": [{ "providerId": "openai" }] }
    },
    "tiers": {
      "strong": "claude-opus-4-6",
      "balanced": "claude-sonnet-4-6",
      "fast": "gpt-4o"
    }
  },
  "tools-common": {
    "tavily":   { "apiKey": "tvly-..." },
    "webFetch": { "trustedDomains": ["github.com", "npmjs.com"] }
  },
  "safe": {
    "classifier": { "model": "tier:fast", "blockRules": ["rm -rf"], "skipStage2": false }
  },
  "observe": {
    "dbPath": "/path/to/observe.db",
    "retentionDays": 30,
    "storeFullContent": false
  }
}
```

- **各包只读自己的 key**(`models` / `tools-common` / `safe` / `observe` / ...)
- **类型安全**:各包导出 zod schema 校验自己的 namespace
- **UI 预留**:未来 Setting 页就是这个 JSON 的可视化编辑,按 namespace 分 tab

### models 三层架构

`models` namespace 是三层结构,高层只引用低层 ID,永不拷贝:

| 层 | 名 | 内容 | 例子 |
|---|---|---|---|
| **1** | ProviderInstance | apiKey + baseUrl + presetId | `anthropic: { presetId: "anthropic_official", apiKey: "sk-..." }` |
| **2** | ModelBinding | 一个 model 聚合多个 supplier,按序 failover | `claude-opus-4-6: { providers: [{ providerId: "anthropic" }, { providerId: "zenmux" }] }` |
| **3** | TierConfig | tier 名 → model id | `{ strong: "claude-opus-4-6", fast: "gpt-4o" }` |

这样的设计使得:
- 切换供应商只改 Layer 1,不影响 Layer 2/3
- 一个 model 只要换 `providers[]` 顺序就能 failover
- `switchModel("tier:strong")` 只需查一层 TierConfig → 一层 ModelBinding → 一层 ProviderInstance

**Model 引用格式**:agent.json 和 SDK config 中用引用字符串而非对象:
- `tier:strong` / `tier:fast` / `tier:balanced` → TierConfig 查找
- `model:claude-opus-4-6` → ModelBinding 查找
- `raw:{"type":"anthropic","apiKey":"...","model":"claude-opus-4-6"}` → 逃逸Hatch
- 裸 model id(如 `claude-sonnet-4-20250514`) → 无 registry 时直传 provider

---

## Context — 每次 LLM 调用的三个原料

| 部分 | 事实源 | 生成方式 |
|---|---|---|
| **system prompt** | `@berry-agent/prompt-pack` PromptPack + `<projectDir>/AGENTS.md` + `<root>/AGENTS.md` + env + skill index | 按"稳定在前、易变在后"拼接:PromptPack base → project AGENTS.md → per-agent AGENTS.md → skill index |
| **messages[]** | `<root>/sessions/<sid>/messages.json` | 每次 LLM 推理前:先原子写当前 session.messages,再读回整个 JSON 数组作为 provider 入参 |
| **tool list** | 代码注册(业务 tool 实现) + `agent.json.toolDenylist`(黑名单) + `.mcp.json`(MCP) | 代码里所有 `addTool` 注册的集合减去黑名单,加上 MCP 适配进来的 |

**cache 友好**(Anthropic 协议 prompt cache):

- **system prompt** 打 2 个 ephemeral 断点:`lastStableIndex`(最后一个不随 turn 变的块,通常是 env + AGENTS.md 交界)+ 整段 system 末尾。因此 **AGENTS.md 改动只会使 skill index 段往后失效,前半段稳定**。
- **messages** 按 `cacheBudget`(默认 2)在最后 N 条 message 的最后一个 content block 打断点,命中率高的是:user 的 tool_result 批。总断点预算为 4(2 system + 2 messages)。

**system prompt 不支持任意构造参数**。SDK 的 `@berry-agent/prompt-pack` 包提供 baseAgent / compactSummary / memoryFlush / handoffResume 等专业提示词;宿主要改项目/agent 静态段应改 AGENTS.md,要替换 SDK 级提示词则传 `promptPack`。

### PromptPack 目录规范

PromptPack 是独立 SDK 包,不属于产品端逻辑。SDK 使用者可以传:

- `promptPack`: pack id 或完整 PromptPack 对象
- `promptPackDir`: 数据目录。首次指定时 SDK 会创建 `packs/` 并写入 3 份内置中文 pack;后续只补缺失 pack,不覆盖用户已编辑内容

目录结构:

```
<promptPackDir>/
└── packs/
    └── berry-default-zh/
        ├── prompt-pack.json
        ├── base-agent.md
        ├── compact-system.md
        ├── compact-summary.md
        ├── handoff-resume-prefix.md
        ├── handoff-resume-suffix.md
        └── memory-flush.md
```

`prompt-pack.json` 只存元数据和文件名映射;实际提示词内容在 markdown 文件中。导入、导出、列表、读取均走 `@berry-agent/prompt-pack` 的 API,产品端只保存 pack id。

---

## Session — 两份文件,职责分离

```
<root>/sessions/<sid>/
├── messages.json     # LLM 眼里的 context
└── events.jsonl      # 完整原始历史(= 前端 UI 时间线的事实源)
```

两份文件**职责正交**:messages.json 是"LLM 眼里的当下"、events.jsonl 是"人类回看的历史"。前者可被 compact 重写,后者永远只追加。

### messages.json

- **作用**:下一次 LLM 调用的 `messages` 入参
- **写入时机**:每次 LLM 推理前先原子写(tmp + rename)再读回;每个 tool loop 后和 turn 结束也会保存
- **格式**:线性数组,可直接塞给 provider
- **可变**:compact 会重写它(把老消息压成摘要 + 近期消息保留)
- **权威性**:resume 时**直接读**,不从 events 重建;损坏了可回退到上一次 turn 的版本(用户按需做)

### events.jsonl

- **作用**:审计、回放、**前端 UI 时间线数据源**
- **写入时机**:每个事件发生即追加一行,永不修改
- **主要事件**:

| 事件 | 时机 | 关键字段 |
|---|---|---|
| `session_start` | 首次建 session | systemPrompt 快照 / projectContext / toolsAvailable / providerConfig / compactionConfig |
| `user_message` | 每次 send/interject | content |
| `api_response` | 每次 LLM 返回 | content / stopReason / usage(inputTokens/outputTokens/cache*) |
| `tool_use_start` | tool 开始执行 | toolUseId / name / input |
| `tool_use_end` | tool 返回 | toolUseId / output / durationMs |
| `compaction_marker` | compact 触发 | level(soft/hard) / layerHits / 前后消息数 / durationMs |
| `memory_flush` | pre-compact flush | 写入的 memory 条目 |
| `crash_recovered` | resume 时发现上次崩了 | artifacts(orphanedTools) / crashedTurnId |

- **不可变**:只追加。compact 只往里加一条 `compaction_marker`,不删旧事件
- **前端用法**:直接读 events.jsonl 渲染聊天历史——可以画出每次 tool input/output 折叠块、compact 分隔线、崩溃⚠️、token 用量图
- **上下文溯源**:`api_request.contextManifest` 记录 promptPackVersion、messageSource=messages.json、system block hash、tools hash、message count。它用于审计"这次 LLM 到底吃了哪份上下文",不是第二份事实源。

### 崩溃恢复

下一次 resume 这个 session 时:
1. 读 messages.json 作为 context(权威)
2. 扫 events.jsonl:若某 `tool_use_start` 的 toolUseId **没有对应的 tool_result 块提交到 messages.json**(不是看有没有 tool_use_end!tool_use_end 也可能在崩溃前飞了出来但 messages 没落盘)→ 视为 orphaned
3. 有 orphan → `interject()` 一条 `⚠️ 上次这些 tool 中断了,副作用未知` 给 LLM + 往 events 追加一条 `crash_recovered` 审计事件
4. 不做代码层 replay,完全靠 LLM 决策继续

`messages.json` 是**唯一权威**。`tool_use_end` 只是审计信号,**不参与**"这个 tool 算不算跑完"的判定。

---

## Compaction

触发条件依据**最近一次 api_response 的真实 inputTokens**;fallback 按字符估算(~4 chars / token)。

| # | Layer | 动作 | Soft (≥60%) | Hard (≥85%) | 调 LLM |
|---|---|---|:-:|:-:|:-:|
| 1 | `clear_thinking` | 清非最新消息的 thinking 块 | ✓ | ✓ | |
| 2 | `truncate_tool_results` | 长 tool_result 截为 50 行(头 25 + 尾 25)| ✓ | ✓ | |
| 3 | `clear_tool_pairs` | 只留最近 5 对 tool_use/result,旧的替换占位 | | ✓ | |
| 4 | `merge_messages` | 合并连续同角色文本 | ✓ | ✓ | |
| 5 | `summarize` | 9 段结构化摘要,近 30% 消息原文保留 | | ✓ | **✓** |
| 6 | `trim_assistant` | >3000 字的 assistant 消息截头尾(1500+1000) | | ✓ | |
| 7 | `truncate_oldest` | 最后手段:只留 30%(≥6),其余换占位 | | ✓ | |

**不变量**:

- compaction 只改 messages.json,events.jsonl 永远完整
- `compactionStrategy` 配置可完全替换默认流水线
- hard 压缩前触发 **pre-compact memory flush**:静默问一次 LLM"有哪些跨 session 仍稳定有效的记忆",只写 durable memory;当前任务续接信息应该进入 compact summary,不进 MEMORY.md
- `compact()` 方法供宿主手动触发(类比 Claude Code 的 `/new`,但保持 session id)

---

## Memory

### 落盘

| 层级 | 文件 | 写入方 | 读取方 |
|---|---|---|---|
| per-agent 主索引 | `<root>/MEMORY.md` | `save_memory` 工具 + pre-compact flush | FTS5 索引 |
| per-agent 主题 | `<root>/memory/*.md` | 宿主或 Agent 编辑(手改) | FTS5 索引 |
| project 级共享 | `<projectDir>/AGENTS.md` | **人类** | system prompt + FTS5 索引 |

**agent 不写 project 级**。Claude Code / Codex / OpenAI 约定一致——项目知识是团队共有的,单方面写入会污染协作。agent 如果觉得团队该知道 → 建议改 `<projectDir>/AGENTS.md` 让人 review,或写自己的 MEMORY.md。

全部通过 `@berry-agent/memory-file` 建 SQLite FTS5 索引,无 embedding。

### 记录时机

- **LLM 主动**:调 `save_memory` 工具写 per-agent MEMORY.md
- **SDK 自动**:hard compact 前的 memory flush(静默 LLM 调用,把"将被压掉"的事实先落进 MEMORY.md)

### 查询

| 工具 | 行为 |
|---|---|
| `memory_search` | FTS5 全文检索(含 per-agent MEMORY + project AGENTS.md),返回片段 + 路径 + 行号 + 分数 |
| `memory_get` | 按路径 + 行范围精确读 |

---

## Skill

- 从 `<root>/skills/` 加载(per-agent,默认)
- `agent.json.skills.extraDirs` 可追加全局 skill 池
- 每个子目录 = 一个 skill,`SKILL.md` 开头 frontmatter 声明 name / description / 激活条件
- 启动时 SDK 只扫 frontmatter 生成**索引**(进 system prompt),正文不进
- Agent 真正需要时调内置 `load_skill` 工具按名拉正文进 messages

---

## MCP

- 从 `<root>/.mcp.json` 加载(per-agent,默认)
- `agent.json.mcp.extraPaths` 可追加额外 MCP 配置路径
- 每个 MCP server 暴露的 tool 被**前缀化**为 `mcp__<serverName>__<toolName>`,和 core / tools-common / 业务 tool 同为一等公民
- MCP server 生命周期跟随 Agent;destroy 时一起关

---

## Tools

### 完整清单

Guard 列说明默认策略下每个工具该走哪档(宿主可覆盖)。

#### `@berry-agent/core` — 内置 runtime tool

| 工具 | 条件 | Guard | 说明 |
|---|---|---|---|
| `load_skill` | 配置了 `skillDirs` | allow | 按名加载 skill 正文到 messages |
| `delegate` | 默认 | allow | 跑 transient session 的独立 turn,共享父 cache 前缀 |
| `todo_read` / `todo_write` | 默认 | allow | session 级短期 scratch pad |
| `sleep` | 默认 | allow | 主动休眠,等 interject/超时 |

#### `@berry-agent/memory-file`

| 工具 | Guard | 说明 |
|---|---|---|
| `save_memory` | allow | 追加 per-agent MEMORY.md,写完顺带更新 FTS5 索引 |
| `memory_search` | allow | FTS5 全文检索(per-agent MEMORY + project AGENTS.md) |
| `memory_get` | allow | 按路径 + 行范围精确读 |

#### `@berry-agent/team` — 多 agent 协同

| 工具 | Guard | 说明 |
|---|---|---|
| `spawn_teammate`(leader) | **ask** | 派生 teammate,默认走人类审批 |
| `disband_teammate` | **ask** | 终结 teammate |
| `message_teammate` / `message_leader` | allow | 队内通信 |
| `list_team` / `read_team_inbox` / `worklist` | allow | 只读 |

#### `@berry-agent/tools-common`

| 工具 | Guard | 说明 |
|---|---|---|
| `read_file` / `list_files` / `grep` / `find_files` | allow | 只读 |
| `write_file` / `edit_file` | **modify**(sandbox) | 写入,默认过 `writeScopeGuard` 限定到 projectDir |
| `shell` | **classifier / ask**(宿主选) | 执行任意命令,必须过策略层 |
| `process_list` / `process_poll` / `process_log` | allow | 只读 |
| `process_write` / `process_kill` | **ask** | 对正在跑的进程做副作用 |
| `web_search` | allow | 只出站读 |
| `web_fetch` | **modify**(domain allowlist) | 默认只允许可信域 |

#### 外部 MCP

`mcp__<server>__<tool>` — 运行时注入。Guard 默认按 MCP server 分组配置,宿主可在 `.mcp.json` 里标注每个 server 的默认档。

### ToolGuard — 机制

所有 tool 调用都过一遍 `ToolGuard(ctx)` 钩子(不区分 tool,全量覆盖),返回四种决策:

| 决策 | 语义 |
|---|---|
| `allow` | 放行 |
| `modify` | 改 input 后放行(如路径沙箱) |
| `deny` | 拒绝,reason 塞回 tool_result |
| `ask` | 交人类审批(HITL)。当前由 `askList` 策略在 guard 内部同步处理(调 AskBridge → 返回 allow/deny),而非作为独立决策类型返回给 core loop。未来可扩展为异步回调 |

**ToolGuard 是机制,不是策略**。core 只定义钩子,**策略在 `@berry-agent/safe` 里组装**,见下面 Safety 章节。

---

## Observability

**三个最小单元**:LLM 推理 / tool use / compact。observe 包不重复造采集点,**只消费 core 的 Middleware 钩子**。

core 的 `Middleware` 接口(`packages/core/src/types.ts`)提供:

| 钩子 | 时机 | 用途 |
|---|---|---|
| `onBeforeApiCall` | provider.chat 调用前 | 改 request / 埋 span start |
| `onAfterApiCall` | provider.chat 返回后 | 记 usage / 结束 span |
| `onApiCallError` | LLM 调用失败(重试用尽) | 记失败原因 |
| `onBeforeToolExec` | tool 执行前 | 埋 tool span start |
| `onAfterToolExec` | tool 执行后 | 记 output / 结束 tool span |
| `onBeforeCompact` / `onAfterCompact` | compact 触发前后 | 记层命中 / 前后 token 数 |

`@berry-agent/observe` 的工作:

1. 注册一组 Middleware 把事件写成 SQLite 行
2. 在自己包内做所有聚合、分析、图表(per-session 耗时、tool 成功率、compact 频次、cost 累计)
3. **不触碰 core**。要加新维度统计 → 加 observe 内的 aggregator,不改 middleware 合同

AgentEvent(`text_delta` / `status_change` 等)是**给 UI 实时流**用的渠道,跟 observe 是两回事:UI 订阅 AgentEvent 做"活的聊天界面",observe 消费 Middleware 做"落地分析"。

---

## Safety

`@berry-agent/safe` 提供策略库,宿主按需**组装** ToolGuard。预置三档:

### Tier 0 — 规则守卫(零 LLM 成本)

`denyList` / `allowList` / `directoryScope` / `rateLimiter` / `compositeGuard` / `writeScopeGuard`。纯函数判断,适合明确红线(禁止 `rm -rf` 等)。

### Tier 1 — 人类审批(HITL)

`askList(toolNames, bridge)`——列出的 tool 一律返 `ask`,交宿主 `AskBridge` 转前端审批。

### Tier 2 — LLM Transcript Classifier

`createClassifierGuard({ modelRef, registry | sdkConfigPath, environment?, blockRules?, allowExceptions? })`。**两阶段、reasoning-blind、高 cache 命中**:

- **Stage 1 — 快速过滤**:同一个 system prompt(block_rules + allow_exceptions + classification_process),user 消息塞 `<current_action>{toolName, input}</current_action>`,强制单 token `YES/NO` 回答,偏向 BLOCK。
- **Stage 2 — CoT 推理**:只在 Stage 1 返 YES 时跑。**系统提示完全相同** → 100% prompt cache 命中。user 消息换成"think step by step,给 `<reasoning>/<decision>/<reason>`"。
- **只看当前 tool 调用**:不给 agent reasoning、不给历史消息(防 reasoning 字段"说服"分类器)。
- **backpressure**:per-session 统计 consecutive/total denials,超阈值抛错升级到人类。

默认 `defaultBlockRules`(17 条)+ `defaultAllowExceptions`(5 条)覆盖"force push、云资源批删、敏感数据外传、装持久后门、绕过安全检查、直推 main、改 production 配置"等常见红线。宿主可完全替换。

**依赖关系**:safe → models(分类器需要一个能跑的小 LLM,通过 models 包解析);safe → config(零配置时从 sdkConfigPath 自动读取);safe → core(ToolGuard 类型)。core 保持零依赖。

### 机制 vs 策略

| | 位置 | 职责 |
|---|---|---|
| 机制 | `@berry-agent/core` | 定义 `ToolGuard` 钩子形状,运行时调用它,尊重返回的 allow/modify/deny/ask |
| 策略 | `@berry-agent/safe` | 提供原料(三档守卫),**不决定用哪档**——宿主 `compositeGuard(...)` 组装 |

SDK 不预设任何策略。宿主决定:个人开发机可能只加 Tier 0(禁敏感命令);生产助手可能 Tier 0 + Tier 2(规则兜底 + LLM 分类);有前端的产品 Tier 0 + Tier 1 + Tier 2 三档全开。

---

## 不在 SDK 里的东西

- **UI** —— 没有 React 组件、没有 CLI 前端
- **认证 / 连接管理** —— SDK 拿到 provider 配置就信
- **部署 / 运维** —— 进程守护、日志轮转、多租户隔离全是宿主的事

---

## 包结构

| 包 | 角色 | 依赖 |
|---|---|---|
| `@berry-agent/core` | Agent、session、events、compaction、内置 tool(delegate/sleep/todo_*/load_skill)、types、Middleware 接口 | (零依赖) |
| `@berry-agent/models` | 三层模型架构(ProviderInstance→ModelBinding→Tier)、`selectProvider()` 引用解析、failover resolver | core(types) |
| `@berry-agent/config` | SDK 级配置加载(`loadSdkConfig`)、各 namespace zod schema 组合校验 | models, safe, tools-common, observe |
| `@berry-agent/memory-file` | MEMORY.md + project AGENTS.md 的 FTS5 索引 + `save_memory` / `memory_search` / `memory_get` | core |
| `@berry-agent/mcp` | MCP server → Berry tool 适配器 | core |
| `@berry-agent/observe` | 基于 Middleware 的采集器,落 SQLite | core |
| `@berry-agent/safe` | ToolGuard 策略库:Tier 0 规则 / Tier 1 HITL / Tier 2 LLM 分类器 / sandbox | core, models, config |
| `@berry-agent/team` | 多 Agent 协同编排、teammate 生命周期、通信 | core |
| `@berry-agent/tools-common` | 通用工具集(文件、shell、搜索、网络) | core |
