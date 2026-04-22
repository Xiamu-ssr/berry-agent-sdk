# 持久化与崩溃恢复

**状态：** v0.4 已实现
**另见：** `DURABILITY.md` (英文完整版), `V0.4-PLAN.md` (v0.4 内化重构)

## 一句话目标

进程中途死掉（OOM、panic、tool 执行时被 SIGKILL）后，下次启动能从事件日志恢复出"模型上一次看到的完全一样的上下文"，并对被打断的 tool 调用给出清晰警告。

## 核心做法

每个 session 写**追加型事件日志**（`FileEventLogStore`，jsonl 落盘）。事件日志是**唯一事实源**，内存 messages 是派生视图。调用 `agent.query(prompt, { resume: sessionId })` 时：

1. `resolveSession()` 读取事件日志，`ContextStrategy` 回放出 messages。
2. `detectCrashArtifacts()`（`event-log/crash-detector.ts` 里的纯函数，**唯一事实源**）扫描孤儿 `tool_use_start`。
3. 若有孤儿：
   - 追加 `crash_recovered` 事件到日志（审计）
   - 通过 `interject()` 给下一次 LLM 调用注入警告消息
   - 发射 `crash_recovered` AgentEvent 给 observe
4. 每进程每 session 只跑一次（`_crashCheckedSessions`）。

## 产品侧 API

```ts
const agent = new Agent({ /* same config */ });
await agent.query('continue please', { resume: sessionId });
```

**没有公开的 `Agent.fromLog(…)`**（v1.5 引入，v0.4 移除）—— 崩溃恢复是基础设施问题，不是产品 API。

## Observe 集成

- `turns` 表 3 个新字段：`recovered_from_crash` / `orphaned_tool_count` / `previous_turn_id`
- `agent_events[kind='crash_recovered']` 行存完整 orphanedTools detail
- `MetricsCalculator.stabilityMetrics(agentId?)` 出 crash 率 + top 孤儿工具
- UI：TurnDetail 顶部 amber 警示条 + TurnList 行内小图标。**不新建 tab**，crash 恢复作为 turn 的一等元数据。

## 非目标

- 事务 / 失败 turn 回滚
- 同一 session 的多写者协调（berry-claw 单进程一 session）

---

*最后更新：2026-04-22 (v0.4 crash-recovery 内化)*
