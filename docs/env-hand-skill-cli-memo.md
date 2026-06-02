# 设计备忘:env / Hand / skill / cli 与 4+1 的关系

> 状态:思考备忘,**未落码**。回答 lanxuan 的思考题,为"删单数主 env"(新-1)和
> "运维转 CLI+skill"(新-2)提供依据。动核心代码前需 lanxuan 过目。

## 思考题(lanxuan 原话)

1. env 不是绑定给 Hand 的吗?多 Hand 为什么不是多 env,agent 不应该感知 env。
2. anthropic 那篇文章,也支持 agent 不直接接触 env 模块吗?env 给 Hand 绑定是最佳的吗?
   不一定,skill 和 cli 是否也需要 env?

## 一、4+1 原文怎么说(查证)

`docs/anthropic-managed-agents-notes.md` 的核心边界原话:

> **the model brain should not own the hands. The harness coordinates model calls
> and execution surfaces.**

拆解这句对我们问题的含义:
- **brain(模型)不拥有 hands** → agent 的"思考"和"执行"是分离的。模型只发出工具调用意图,
  不直接持有执行能力。✅ 支持 "agent 不直接接触 env"。
- **harness 协调 model calls 和 execution surfaces** → 是 harness(我们的 ManagedAgentRuntime)
  把"工具调用"路由到"执行面",不是模型自己去碰执行面。
- 原文把 **Tools/MCP** 和 **Sandbox** 列为**两个并列组件**。Sandbox = 执行环境。Tools = 能力接口。
  它们是分开的格子 —— 这暗示:**能力(Tool/Hand)和执行环境(Sandbox/env)是两层,不是一回事**。

**结论(回答 #2 前半)**:4+1 确实支持"agent 不直接接触 env"。模型只见 Tool;Tool 在哪执行
(哪个 sandbox/env)由 harness 解析。agent 对 env **无感知**是符合原文的。

## 二、env 该绑给 Hand 吗?(回答 #1 + #2 后半)

lanxuan 的命题:"env 绑给 Hand,多 Hand 即多 env,agent 不感知 env"。

**这是对的,而且是比当前实现更干净的模型。** 论证:

- agent 看到的是一组 **Tool**(来自各 Hand)。它调 `machine_mac-1_exec`,不知道也不关心背后是
  哪个 env。✅ agent 不感知 env。
- 每个 **Hand** 内部绑一个 **executor / env**:本地 Hand 绑本地 sandbox,机器 Hand 绑远程机器,
  容器 Hand 绑容器。**多 Hand = 多 env**,字面成立。
- 这样 env 不是 agent 的全局属性,而是**每个 Hand 各自的实现细节**。agent "操作多个 env" =
  "挂多个绑了不同 env 的 Hand"。

**但 env 绑给 Hand 是不是"最佳"?诚实回答:不绝对,有一个真实的张力。** 两种建模:

- **(甲)env 完全隐于 Hand 内**(lanxuan 倾向):Hand 自带 executor,外部只见 Tool。
  优点:agent / harness 都不需要"env"这个概念,最少认知负担。
  代价:多个 Hand 想共享同一个 env(同一个 sandbox / 同一台机器的多组工具)时,
  env 的生命周期(创建、复用、dispose)散在各 Hand 里,不好统一管。
- **(乙)env 是一等对象,Hand 引用 env**(4+1 把 Sandbox 单列,偏这个):
  env 独立存在、可被多个 Hand 共享、有自己的 provision/dispose 生命周期;Hand 持有"我用哪个 env"的引用。
  优点:一个 env 上挂多个 Hand(shell + file + search 共享一个 sandbox)很自然,生命周期集中。
  代价:多了"env"这个 agent 不该感知、但 harness 要管的中间概念。

**4+1 原文偏乙**(Sandbox 是和 Tools 并列的一等组件,不是藏在 Tool 里的)。而 lanxuan 的直觉偏甲
(更极简)。**两者不矛盾,可以统一**:env 是一等对象(乙,满足共享 + 生命周期),但
**agent/模型永不见它**(甲的核心诉求,4+1 也要求)。也就是:

> **env 一等存在(harness 管),Hand 引用 env,agent 只见 Tool。** env 对 agent 隐形,
> 但对 harness 显形。这同时满足 lanxuan 的"agent 不感知 env"和 4+1 的"Sandbox 是一等组件"。

## 三、当前代码的真实状态 vs 上面的理想

查证 `runtime/build.ts buildHands(scope, options, executionEnvironment)`:

- ✅ **机器 Hand 已是理想形态**:`machine_<id>_exec` Hand 内部绑死该机 executor,agent 不感知。
  多机器 = 多 Hand = 多 env,完全自洽。
- ⚠️ **localWorkspace Hand 是旧疤**:它从一个**单数全局参数 `executionEnvironment`** 拿 env,
  而不是"自带 env"。这制造了一个隐含的"主 env"概念 —— 既不是甲也不是乙,是历史遗留的
  "单数特殊化"。**这就是该删的多事实源**:env 既能绑 Hand(机器 Hand),又能当全局单数(localWorkspace)。

**新-1 的正确目标**:删掉 `buildHands` 的单数 `executionEnvironment` 参数,让 localWorkspace Hand
也走"引用一个 env 对象"的路子(那个 env 仍可是默认本地 sandbox,但作为一等对象传入,
而非全局单数)。统一成 §二 的"env 一等、Hand 引用、agent 不感知"。
- 风险:动核心装配 + 778 测试覆盖的热路径。**不无监督做**,需 lanxuan 确认建模方向(甲/乙/统一)。

## 四、skill 和 cli 需要 env 吗?(lanxuan 思考题 #2 末)

这是最尖的一问,答案分两层:

**skill 不需要"自己的 env",但它的执行依赖某个 Hand 的 env。**
- skill 是**给模型读的指导**(SKILL.md:"装 worker 就这样拼命令")。它本身不执行任何东西,
  没有 executor,不需要 env。
- 但 skill 教模型调的那些工具(shell / machine exec)**通过 Hand 落到某个 env**。
  所以 skill"间接"依赖 env —— 依赖的是它指导模型去用的那个 Hand 的 env,不是 skill 自带。
- **推论**:skill 是"纯知识层",env 是"执行层",两者正交。skill 不该有 env 字段。✅

**cli 同理,但更微妙 —— 这正好回答新-2。**
- 如果"运维 a8s"做成 CLI(新-2):agent 通过**通用 shell Hand** 调 `berry-a8s ...`。
  那个 shell Hand 绑某个 env(worker 本地)。**CLI 在那个 env 里以子进程执行。**
- 所以 cli **不需要自己的 env**,它复用"执行它的那个 shell Hand 的 env"。这跟 skill 一样:
  knowledge/command 层不持 env,执行层(Hand+env)持 env。
- **这反而强化了新-2 的正确性**:把运维从"专用 tool(各自硬编码,藏在 cluster-admin Hand 里)"
  改成"CLI + skill",等于把"运维能力"从**执行层**(Hand/env,本不该承载具体业务)
  挪到了**知识层**(skill)+ **通用执行**(shell Hand)。层次更干净:
  - 现在:运维 = 10 个硬编码 tool(执行层背了业务语义,该删)。
  - 应该:运维 = 1 份 skill(知识)+ 通用 shell Hand(执行)+ `berry-a8s` CLI(a8s 出的稳定接口)。

**一句话**:env 只属于执行层(Hand)。skill 和 cli 都是"在某个 Hand 的 env 里被使用/执行"的东西,
自己不持 env。把运维语义从 tool(执行层)移到 skill(知识层)是更符合分层的做法。

## 五、给 lanxuan 的结论与待拍板

1. **env 绑 Hand、agent 不感知 —— 你的直觉对,4+1 也支持**(brain 不拥有 hands)。
   唯一补充:env 最好仍是**一等对象**(可共享 + 生命周期),只是对 agent 隐形。
2. **新-1(删单数主 env)方向正确**,是消除真实多事实源。但动核心,需你确认建模(我推荐"env 一等、Hand 引用、agent 不感知"),再做。
3. **新-2(运维转 CLI+skill)被这次分析进一步证明正确**:运维语义属知识层(skill),不属执行层(tool/Hand)。
   前提是 a8s 出一个稳定的运维 CLI。这是产品决定,你拍。
4. skill / cli **不持 env**,复用执行它们的 Hand 的 env。这条可作为以后的不变式写进 AGENTS.HTML。

相关:[[product-infra-boundary]] [[collaboration-substrate-plan]] [[machine-layer-design]]
