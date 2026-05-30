# 机器层设计:机器即 Environment / Hand

> 状态:设计已与 lanxuan 在 2026-05-29~30 多轮对话中逐条拍定。本文是落码前的事实源。
> 配套:`AGENTS.HTML`(平台北极星)、`docs/anthropic-managed-agents-notes.md`(理念推导)。

## 0. 一句话

把一台机器接入 a8s,等于在集群里多了一个 **ExecutionEnvironment**;这个 Environment
自动 `createHands()` 产出一组**绑死本机执行落点**的 Hand(通用 exec/file + 本地 MCP),
agent 按需装载。**没有人"写 Hand";Hand 是机器接入时盘点本地能力投影出来的。**

## 1. 三层抽象(名词对齐)

聊的过程中反复澄清,这三个词的从属关系是整个设计的地基:

| 名词 | 是什么 | 类比 |
|---|---|---|
| **Hand** | 能力的声明(暴露哪些工具)+ 调用路由(`execute` 转发给工具) | 菜单 + 服务员 |
| **Tool** | 一个具体能力,持有一支 executor | 一道菜的做法 |
| **ExecutionEnvironment** | 命令真正落地的物理点;`createCommandExecutor` / `createHands` | 厨房 |

**Environment 是工厂,Hand 是产品。** 一台机器(Environment)`createHands()` 吐出绑死本机
executor 的 Hand。Hand 攥一根通向机器的管子,不"拥有"工厂。

关键推论:
- **OS 差异(Mac/Linux)不是能力定义问题,是执行落点问题** —— 命令在目标机真实 shell 跑,
  executor 自动吸收差异。同一份 `shell` 工具定义,executor 指 Mac 就在 Mac 跑。
- **拒绝执行不在 Environment**,在独立的 `ManagedToolGuard`(safe 包)。Environment 的
  `isolationPolicy` 只管物理边界(读写路径/网络)。两层都用:guard 决策"允不允许",
  isolationPolicy 约束"物理能碰哪"。
- brain 对 environment **几乎无感知**:它只看到一堆 Hand,不知道 `machine-b.shell` 背后
  那根管子通到哪。这正是"Hand 配置不绑机器"原则的回报。

## 2. Hand 的四层来源(谁写代码)

| 来源 | 要写代码吗 | 谁负责 | 例子 |
|---|---|---|---|
| **L0 通用工具** | ❌ | SDK 自带(`tools-common`) | 文件、shell、search、web |
| **L1 现成 MCP** | ❌ 填配置 | 机器本地 `.mcp.json` | GitHub/Slack/Playwright/已有的企业 MCP |
| **L2 新 MCP** | ✅ 但写的是标准 MCP server,非 Berry Hand | 你/公司,一次性 | 企业内部独有、市面没有的工具 |
| **L3 产品预装** | ❌ 用户不写 | 产品(berry-claw) | 装机时预置 MCP + UI 加 MCP 按钮 |

**"写 Hand 代码"这个动作在 Berry 里不存在。** 你最多写 MCP server(L2),且只在"全世界没有
现成"时。终端用户 100% 是点 UI / 填配置;写代码被关进产品作者 + MCP server 作者的一次性工作。

## 3. 机器接入流程

```
机器 connector 启动
  → 盘点本机能力:
      ├─ SDK 通用工具      → 投影成 exec/file Hand(executor 绑本机)
      └─ 本机 .mcp.json    → 每个 MCP server 投影成一个 Hand
  → 主动出网 register 到 a8s(带 callbackUrl + token,复用 worker 注册机制)
  → 周期 heartbeat
a8s
  → 登记进 Hand 池:"machine-X 提供这些 Hand"
  → agent 创建/运行时,按选择把某机器的 Hand 注入(路线甲,见 §4)
```

双向连接:机器**主动出网** register,a8s 记下 callbackUrl 后可**回调**。不是对等 P2P。
和 worker 同构,只是 worker 报 capacity、connector 报 capability。

**connector ≈ 极简 worker**:把"挂载 agent runtime(重)"换成"提供通用 exec(轻)"。
它就是一个 remote ExecutionEnvironment 的机器侧实现。脚本装的是"机器的远程执行端点",
不是 worker。worker 退化成 agent 用这个端点装出来的产物之一。

## 4. 路线甲:机器 Hand 作为「附加 Hand」注入

当前 `runtime/build.ts` 把 executionEnvironment 建模成**单数主角**(brain 自己跑的地方)。
机器层**不**把它复数化(那是 brain 飘到远程机跑 = 跨机 failover,alpha 不做)。

取而代之:**机器的远程 exec 能力作为「附加 Hand」注入**,走 hostTools 同一通道——
`build.ts` 的 hostHand(cluster-admin / team 已在用)已证明此通道干净。

```
brain
 ├─ 主环境(本机 sandbox)     → brain 自己跑命令的地方,单数,不变
 ├─ Hand: machine-b.exec      → 工具 execute 调 machine-b 的远程 /exec transport
 ├─ Hand: machine-c.exec      → 工具 execute 调 machine-c 的远程 /exec transport
 └─ Hand: cluster-admin        → 纯 HTTP,无 executor
```

模型看到:本机 shell + `machine-b` 的 shell + `machine-c` 的 shell + cluster-admin。
**"选 Hand = 选机器"字面成立**。相同工具定义复用同一份代码,只换 executor。

注入机制复用现有 label-driven resolveSpec(`labels.role=a8s-admin` 注入 cluster-admin 的
同一套路):agent spec 上声明"我要用 machine-b 的 Hand",worker resolveSpec 据此把
对应远程 exec Hand 追加进 hostTools。

## 5. SDK 现状(落码前盘点 —— 大部分已存在)

调研 `tools-common` 后确认,brain 侧能力**已经齐了**:

- `createRemoteExecutionEnvironment`(remote-environment.ts):brain 侧 push/HTTP 环境,
  `createCommandExecutor` 调远程 `/exec`。wire schema `remoteExecRequestSchema` /
  `remoteExecReplySchema` 已存在。
- `createPollingExecutionEnvironment` + `PollingExecutorAgent`(polling-environment.ts):
  防火墙友好的反向变体(机器只出站 poll)。wire schema `pullingTaskRequestSchema` /
  `pullingTaskResultSchema` 已存在。
- `NodeExecutor`(executor.ts):机器侧真正执行命令的实现。

**所以机器层主要是装配 + 接线,不是从零造轮子:**
- 机器侧 daemon = `PollingExecutorAgent`(或服务 `/exec`)backed by `NodeExecutor` + register-to-a8s。
- a8s 侧 = 把注册的机器表示成 remote Environment,`createHands` 出 exec Hand,label 注入。

## 6. 待收紧的隐式契约

`shell.ts` 默认 `executor = options?.executor ?? new NodeExecutor()` —— 不注入 executor
就静默裸跑(无沙箱)。**机器 Hand 必须 fail-closed**:拿不到指向目标机的 executor 就拒绝构造,
绝不静默回退本地 NodeExecutor(否则"远程机器 Hand"可能在 brain 本机裸跑,灾难)。

落地:机器 exec Hand 的 executor 必填且显式绑定目标机 transport,无回退路径。

## 7. MCP 远程化(方案甲)

Mac 上 MCP server 保持本地 stdio 原样,connector 做代理:
brain 工具调用 → a8s/connector 转发 → 机器侧 connector 喂给本地 MCP stdio → 结果回传。
MCP server 无感知(还是普通 stdio server),用户现有 MCP 配置零改动就能被云端 brain 用上。
这是"云端 a8s 取代本地 Engine"的关键:本地怎么配 MCP,接入后云端照样能用。

## 8. 实现顺序(M1–M7 全部完成)

1. ✅ **M1** 收紧 executor 契约(fail-closed,`requireExecutor`)。
2. ✅ **M2** cluster-protocol 机器端点 wire schema(register/withdraw/heartbeat/exec/mcp)。
3. ✅ **M3** machine connector daemon(通用 exec)。
4. ✅ **M4** a8s 机器注册 → remote Environment → label 注入 Hand(路线甲)。
5. ✅ **M5** install-worker skill。
6. ✅ **M6** connector 本地 MCP 代理 → Hand。
7. ✅ **M7** UI 机器管理 + AGENTS.HTML 机器层章节。

### M6 落地细节(MCP 一等公民 + 双重命名空间)

- **a8s 保持 MCP-agnostic**:connector 在机器本地连 `.mcp.json` 的 MCP server(持久 stdio
  连接只在机器本地),启动时 `listTools` 汇成 manifest 在 register 时上报。a8s 只存 manifest
  verbatim,只转发一问一答的 `{server, name, input}` invoke(`/v1/machines/:id/mcp/invoke`
  broker,与 exec broker 同构)。没有持久连接穿过 a8s。
- **brain 侧投影(一等公民)**:`buildMachineTools` 为每个 manifest tool 生成一个模型可见
  工具,命名 `machine_<id>__<server>_<tool>`——机器命名空间 + MCP server 命名空间双重体现
  (对齐 Claude Code 的 `mcp__server__tool`,但前缀加上机器)。dispatch key 是上游
  `(server, name)`,模型可见的前缀永不泄漏回 MCP server。
- **manifest 获取 vs resolveSpec 同步约束**:worker daemon 的 `withMachineHostTools` 维护一个
  manifest 缓存,首次 resolve 某机器时后台拉取(`GET /v1/machines/:id/mcp/manifest`),exec
  工具立即可用,MCP 工具在缓存暖了之后的下次 mount 出现。manifest 小且少变,惰性暖缓存是对的
  取舍——不阻塞、最终完整。
- **二等公民(渐进披露)是未来 SDK 投影层的独立优化**,对所有 Hand 通用,不只 MCP,不在本轮。
  详见 [[product_infra_boundary]] 的调研结论。

## 9. 未来(不在本轮)

- **MCP 二等公民投影**:tool 数过多时,SDK 侧 Hand→tool 投影改渐进披露(search_tools /
  code-exec 元工具)。全行业当前默认一等平铺;Anthropic 在推二等。发生在 brain 投影层,
  不碰机器层协议。可选轻量护栏:工具数超阈值告警(对齐 Cursor)。
- **Environment 池 / Hand 池**:a8s 的基础注册表。机器层是 Environment 池第一个成员。
  池化的 UI/注册表是增量,不返工。
- **Agent 模板池**:复用"起点配方"(system prompt + 预选 Hand + Environment 配方),
  实例化出全新 session 的 agent。复用配方不复用 session 实例(session 带身份+因果,
  共享 = 抢 lease,违反不可变原则)。偏产品向(a8s Engine 侧)。
