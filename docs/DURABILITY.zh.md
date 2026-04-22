# 持久化设计 — 让 Agent 不怕 `kill -9`（中文版）

> 状态：草案，2026-04-22 起草，等 lanxuan 拍板后开工。

---

## 1. 核心问题：宕机后，Agent 能记住多少？

现在的 berry-claw，进程一崩， Agent 会变“失忆”。**不是所有东西都丢了，但丢的恰好是关键的部分**。

### 现在的持久化清单

| 存了的东西 | 文件位置 | 宕机后能否恢复 |
|:---:|:---:|:---:|
| Agent 配置（id, model, systemPrompt） | `~/.berry-claw/config.json` | ✅ |
| Agent 私有工作区（AGENT.md, MEMORY.md） | `~/.berry-claw/agents/<id>/` | ✅ |
| 原始对话（user 说了啥、model 回了啥） | `sessions/ses_*.jsonl` | ✅ |
| Team 状态 | `<project>/.berry/team.json` | ✅ |
| Worklist | `<project>/.berry/worklist.json` | ✅ |
| **发给 LLM 的完整消息窗口 `messages[]`** | **不存** | ❌ |
| **compaction 后的 summary** | **只在内存** | ❌ |
| **api_call 的 request body（带了啥工具、参数）** | **不存** | ❌ |
| **Tool 执行到一半崩了** | **没有标记** | ❌ |

---

## 2. 缺失了什么？逐个讲

### Gap ①：System Prompt 不在 session log 里

System Prompt 只存在 `config.json` 里。如果用户 mid-session 改了 system prompt（比如换个 persona），session log 不知道“第 3 轮用的是旧 prompt”。

重启后，系统会把**当前**的 system prompt 塞给下一轮。但这个 prompt 可能和 session 启动时不同，会导致 agent 行为漂移。

### Gap ②：发给 LLM 的 `messages[]` 不存

这是**最核心的问题**。

Berry 的每轮 query 不是简单把原始对话直接发给模型。中间做了很多事：
- **compaction**：旧消息被压缩成 summary，summary 替换了原始消息放进 messages[]
- **toolGuard**：tool 调用的结果可能经过 guard 拦截，guard 的拦截信息被注入 messages[]
- **projectContext**：AGENTS.md 的内容被塞进 system prompt 块
- **skill injection**：skills 作为 system prompt 的一部分

这些加工后的 `messages[]` **最终版**才是实际发给 LLM 的。但我们只存了**原材料**（原始对话），没存**成品**。

**宕机后会发生什么？**

重启 → SDK 从 jsonl 读原始事件 → 重新构建 messages[] → 重新 compaction → **summary 可能和上一次不同**（因为 LLM 不是确定性的）→ agent 的“记忆”变了。

这是 bug：agent 的上下文窗口是个**确定性派生**的视图，重启后应该得到**完全相同**的视图，但现在不能保证。

### Gap ③：api_call 只记了 token，没记 request body

event log 里有 `api_call` 事件，但只记了 `inputTokens` / `outputTokens` / `modelId`。它**没记**我们到底发了什么：
- 发了多少条 message？
- 每条 message role/content 是什么？
- 这次带了哪些 tools？
- provider 参数（temperature 等）是多少？

调试时没法重现“为什么这轮 token 花了 40k”。未来做 observe 和审计，没有 request body 就是瞎子。

### Gap ④：Tool crash marker

假设 agent 调了一个 tool（比如 `writeFile`），写了 `tool_use` 事件到 log，**然后进程崩了**。disk 上只有 `tool_use`，没有 `tool_result`。

重启后，agent 不知道这个 tool 到底执行了没有。writeFile 可能已经写了半个文件，也可能完全没写。下次 query 时 agent 会继续正常聊天，不会意识到“我有个未完成的 tool”。

---

## 3. 怎么修？分三阶段

### Phase 1 — 写 3 种新 event

**`session_start`**  
每个 session 文件的第一条。记这个 session 启动时的完整环境：
- `systemPrompt`（当时的，不是 config.json 当前的）
- `projectContextSnapshot`（AGENTS.md 的内容，当时的）
- `toolsAvailable`（当时挂载了哪些 tools）
- `guardConfig`（toolGuard 配置）
- `compactionConfig`（compaction 阈值等）
- `providerBinding`（当时绑定的模型和参数）

**`messages_snapshot`**  
在每次 compaction 完成后立即写。内容是**compaction 后的完整 `messages[]` 数组**（包含 summary + 未压缩的近期消息）。

这是“快照点”。重启时，SDK 不需要 replay 几百轮历史事件再重新 compaction——它直接读最后一个 snapshot，追后面少数几轮新事件即可。

> 类比：数据库的 binlog + checkpoint。事件 log 是 binlog，messages_snapshot 是 checkpoint。

**`api_request` / `api_response`**  
`api_request`：写 requestId + 完整 request body（messages + tools + params）。  
`api_response`：写 stopReason + content + usage + requestId（和 request 对账）。

取代现在干瘪的 `api_call`。

### Phase 2 — `Agent.fromLog()` 热启动 helper

```ts
Agent.fromLog(sessionId, { provider, sessionStore }): Promise<Agent>
```

实现逻辑：
1. 读 jsonl 文件
2. 找最新的 `messages_snapshot` → 这就是当前 context window 的基底
3. 从 snapshot 之后的事件中，replay `user_message` / `assistant_message` / `tool_use` / `tool_result` / `api_response` 到 messages[] 中
4. 返回一个 ready-to-query Agent

### Phase 3 — Tool crash recovery

把 `tool_use` 改成两阶段写：
- `tool_use_start`：在调用 tool 之前写（现在 `tool_use` 就是这里）
- `tool_use_end`：在 tool 返回后写（现在 `tool_result`）

重启加载时扫描：如果存在没有 `tool_use_end` 配对的 `tool_use_start`，说明这个 tool 执行到一半崩了。

处理：把这个未完成的 tool 信息注入下一轮 query 的 messages[] 中作为一条 system message：

> "⚠️ Tool `writeFile` (args: ...) was interrupted during execution on the previous turn. Its side effects are unknown. Please assess whether to retry or proceed."

这是 Codex 的同款做法。

---

## 4. 兼容性

现有的 jsonl 格式完全兼容。新 event 类型只是 append。reader 遇到不认识的事件类型就跳过。

已经存在的 session 日志不需要迁移。它们只是“不能从 snapshot 恢复”——SDK 可以 fallback 到当前行为（replay 所有事件）。等新 session 被创建后，就会自动开始写 `session_start` 和后续 snapshot。

---

## 5. 等你的决策

lanxuan 请确认：

1. **Event schema 方向对吗？** 特别是 `messages_snapshot` 存整个 `messages[]`（可能几十 KB 到几百 KB），你觉得大小 OK？
2. **写 snapshot 的时机：** 每次 compaction 后写一次，够吗？要不要每次 turn 结束也写（更保险但更大）？
3. **Tool crash 恢复文案：** 写成 system message 注入下一 turn，这个行为你想要？还是宁愿让 agent 自己从 event log 推断？

确认后开工 Phase 1。
