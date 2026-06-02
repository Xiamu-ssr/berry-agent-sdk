# 设计备忘:新-1 — 拆 localWorkspace,本机降格为普通 env

> 状态:落码前事实源。lanxuan 已拍板方向("本机不该特殊")。本文先厘清
> **代码真相 vs 文档理想**,再定最终形状。配套:[[env-hand-skill-cli-memo]]、
> hands-environments-and-machines.md、machine-layer.md。

## 0. 缘起

`berry-a8s-ops`(新-2)收尾时,凭证注入暴露了一件事:agent 级"主执行环境"
身兼两职(本机厨房 + 凭证挂载点),却被建模成 build 参数里一个不起眼的单数
字段。顺藤摸下去发现 localWorkspace 是一处真正的多事实源。lanxuan 的问题
"本机为什么不也解耦成 Hand/env"直接定了方向。

## 1. 代码真相(grep 实证,与文档不符)

**文档说**(hands-environments-and-machines.md / machine-layer.md):
"Environment 是工厂,`createHands()` 生产绑死本机 executor 的 Hand"。

**代码实际**(build.ts + 全库 grep + runtime-builder.test.ts):
- `executionEnvironment.createHands?.(scope)` **是正经扩展点**:env 用它提供
  自己的额外 Hand(远程浏览器、远程文件桥)。runtime-builder.test.ts "mounts
  hands supplied by the execution environment" 在用它(env 出 `browser_navigate`)。
  **保留。**(初稿误判它是死 hook;测试纠正了——它生产的是 env 的*额外*能力,
  不是 workspace 工具。)
- 但**本机的 file/shell/search/web 不走 createHands**,全靠 build.ts 的 localWorkspace
  特殊分支(`createLocalWorkspaceHand`)塞入;machine exec Hand 走 worker resolveSpec
  的 hostTools 注入(`withMachineHostTools`)。**三条不同的路** —— 这才是多事实源。

**结论**:三类 Hand 并存且来源各异 ——(1) env 的额外 Hand 走 createHands;
(2) workspace 工具走 localWorkspace 特殊分支;(3) machine exec 走 hostTools 注入。
新-1 统一的是 **(2)**:把 workspace 工具从"特殊分支 + 混装 web"改为"从 env 的
executor 集中组装的 work hand + 独立 web hand",本机/远程同构。createHands 不动。

## 2. localWorkspace 的两宗罪

1. **历史特殊化**:它早于机器层。本机 work hand 走"build 选项特殊分支",
   而非和其它 env 同构 → 第一处多事实源(env 获取路径不统一)。
2. **错误打包**:`createLocalWorkspaceHand` 把两类本质不同的工具塞进一包:
   - file/shell/search → **要落到某机器文件系统**(需 executor/env)
   - web_fetch/web_search → **纯 API,不碰任何机器**(无 env,本机关机也能用)
   把"需厨房"和"不需厨房"混装,正是它无法干净同构化的根。

## 3. 最终形状(本机不特殊)

把工具按"是否落地到某机器"分两类,与"在哪台机器"正交:

| 类别 | 谁生产 | executor | 例子 |
|---|---|---|---|
| **落地类(workspace 工具)** | 某台机器的 env | 焊死该机 | file / shell / search |
| **无 env 类(纯 API Hand)** | agent 级直接挂 | 无 | web / cluster-admin / berry-a8s-ops 投影 |

落地后:
- **本机 = 一台 env**,和远程机同构。其 work hand 由"统一的 work-hand 构造器"
  从 env 的 executor 生产,**本机/远程一条规则**。
- **web 工具拆出来**,成为 agent 级"无 env Hand",与 cluster-admin 同类。
- **localWorkspace 这个混装概念消失**。
- **brain 的"老家"= 一个标记(primary)**,不是一套特殊装配逻辑。老家那台 env
  仍承载默认 cwd + CLI 凭证/子进程(berry-a8s-ops 依赖),但工具生产方式与
  远程机完全对称。

### 落地方式(已定)

workspace 工具**不**塞进 `env.createHands`(那是 env 的*额外*能力扩展点,语义不同,
保留)。而是在 build.ts 用"统一 work-hand 构造器"`createWorkspaceToolsHand` 从 env 的
executor 显式组装(本机/远程同一函数),web 用 `createWebHand` 独立挂(无 env)。
保持"env 只出 executor 管子 + 额外 Hand,workspace 组装逻辑集中一处",符合
[[env-hand-skill-cli-memo]] "env 一等、Hand 引用 env、agent 不感知"。machine exec Hand
现状(hostTools 注入,executor 焊远程)与此同构,无需为本机发明新通道。

## 4. 改动面(增量,每步 build+test)

1. **tools-common**:
   - 新 `createWorkspaceToolsHand({ scope, executor?, allowedTools })` —— 只含
     file/shell/search,executor 来自传入 env(无则 fail-closed 或显式 NodeExecutor)。
     本机/远程共用。
   - 新 `createWebHand({ credentials })` —— 只含 web_fetch/web_search,无 env。
   - `createLocalWorkspaceHand` 删除(混装概念消失);`workspace-hand.ts` 瘦身。
2. **runtime/build.ts**:
   - `buildHands` 改为:work hand(从 resolved env 的 executor 组装)+ web hand
     (agent 级)+ hostHand。删 localWorkspace 特殊分支与休眠的 createHands 调用。
   - 选项 `localWorkspace` → 语义更清晰的命名(如 `workspaceTools?: false | {allowedTools}`
     + `webTools?: false`)。保留 `false` 关断能力。
3. **runtime/index.ts**:选项类型同步。
4. **worker/{types,builder}.ts**:`localWorkspace` 字段改名透传。
5. **测试**:tools.test.ts(createLocalWorkspaceHand 块重写为 work/web 两块)、
   runtime-builder.test.ts、worker/builder.test.ts、a8s-server e2e 同步。
6. **文档**:hands-environments-and-machines.md 改"createHands 工厂"叙述为真相
   (env 出 executor,work-hand 构造器集中组装);machine-layer.md §4 对齐。

## 5. 不变式(沉淀进 AGENTS,回答 lanxuan 6/2 思考题)

> **env 只属于"落地到机器"的工具(workspace 工具 + machine exec)。web / API /
> skill / cli 不持 env——它们或是无 env Hand(web),或寄生在执行它们的那个 Hand
> 的 env 里(cli 在 work hand 的 env 子进程跑)。本机不是特殊装配,只是一台贴了
> primary 标记的 env。**

## 6. 红线(machine-layer §4,不碰)

- **不复数化 primary env**(brain 飘到远程机跑 = 跨机 failover,alpha 不做)。
  本机仍是唯一 primary,远程机仍是"附加 Hand"。本次只统一**工具生产方式**,
  不改"brain 在哪跑"。
- 不动 lease/wake/worker 状态机。
- alpha 无兼容包袱,旧 API 直接删不包。

相关:[[env-hand-skill-cli-memo]] [[collaboration-substrate-plan]] [[machine-layer-design]]
