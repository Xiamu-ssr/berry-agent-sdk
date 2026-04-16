# 工作笔记（4/16 上午，完成后删除）

## 今日任务
1. [x] Observe dark mode 泄漏到全局 → scope 到容器内
2. [ ] Observe 侧边栏重排：记录 vs 分析分组
3. [ ] ~/.berry-claw 目录结构规划 + 实现
4. [ ] Agent 栏目（berry-claw 前端）
5. [ ] 无 Agent 时不允许聊天
6. [ ] 双写技术债（去掉 session.messages，只用 event log）

## 设计备忘
### ~/.berry-claw 目录结构
```
~/.berry-claw/
  ├── config.json           # 全局配置（providers, defaults）
  ├── observe.db            # Observe SQLite
  ├── agents/               # 每个 agent 一个子目录（自动创建）
  │   ├── default/
  │   │   ├── agent.json    # { id, name, model, systemPrompt, createdAt }
  │   │   ├── AGENT.md      # system prompt（可编辑）
  │   │   ├── MEMORY.md     # agent 长期记忆
  │   │   └── .berry/
  │   │       └── sessions/ # JSONL event logs
  │   └── coder/
  │       └── ...
  └── sessions/             # 旧版 session store（兼容）
```
- Agent 创建时自动在 agents/{id}/ 下初始化
- config.json 的 agents 字段只存引用（id → agents/{id}/agent.json）
- workspace 不再是用户指定的全局目录，而是每个 agent 独立
