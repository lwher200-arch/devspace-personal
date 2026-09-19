# 研究成果到 DevSpace 的工程映射

本页把 Eterna 相关研究中适合 DevSpace 的部分转换为可验证的软件工程约束。名称可以保留，
但运行时只接受有明确消费者、测试和权限边界的机制。研究概念不能作为扩大权限、绕过验证、
伪造遥测或自动重试未知执行结果的依据。

## 已进入运行路径的 P0 能力

### Canonical Intent IR 与梦语语义压缩

`src/control-plane/intent.ts` 提供第一版 Canonical Intent IR。当前只提取可确定复现的任务
复杂度与架构、安全、迁移、并发、根因等路由信号，不推断用户权限、真实风险概率或提供方
可用性。它是“梦语系统”高密度语义表达的工程化最小子集，不是新的自然语言解释器。

### 奇美拉协议

`src/control-plane/chimera.ts` 将原先嵌在 Codex 执行模块中的 routine/complex 判断抽成纯路由层。
当前消费者仍是受保护 Codex 双模型策略，但协议本身不拥有权限：模型选择不能扩大 allowlist、
写权限或 sandbox，也不能在失败后自动换 provider 重跑。以后扩展到 Claude/OpenCode/Pi 等异构
执行器时，仍应复用现有 LocalAgentManager 和 provider adapters，而不是新建第二套 daemon。

### 回游模式 / RCF

`src/control-plane/returnflow.ts` 固化 `Observe -> Diagnose -> Counterfactual -> Guard -> Act -> Verify
-> Anchor -> Relaunch`。当前有两个真实消费者：Codex 不确定交付始终先 reconcile，不能把缺失
回执当作安全重试；Owner 拒绝后只有用户明确要求重新申请时，才允许通过 `reissue_approval`
进入 RELAUNCH。旧拒绝记录不会被改写成批准，新请求仍需新的人工决定。

面向长期工作区授权的设计与实现状态见 [A2 Execution Boundary](a2-execution-boundary.md)。Linux
默认服务路径已接入 Bubblewrap v4，覆盖 `exec_command` / `bash` / `run_process`；实际隔离仍需
运行时自检。租约存储、Candidate 副本与执行协调已有实现，但租约申请/激活入口尚未向普通客户端
开放，promotion 和 Candidate 重启恢复仍未完成。现有精确命令租约仍属于 legacy，不能当作 A2 租约。

### Pattern Folding / Context Fabric

`src/control-plane/context-fabric.ts` 将早期“折叠压缩”收敛为可验证的上下文契约：
`Context = Anchor + Delta + Exception + EvidenceRef`。事实性 statement 必须关联外部证据引用；
`supersedes` 显式淘汰旧状态；`ContextBudget` 只在预算内选择可选信息，而 required context
放不下时直接失败，不允许静默截断。Token 数由调用方提供估算，本模块不伪造 tokenizer。

`context_fabric` 已作为单一低 schema MCP runtime consumer 接入候选源码：可在 workspace 范围内
以内存方式 `put_anchor -> append_delta -> capsule`，并复用上述证据与预算约束。Store 由服务级
生命周期持有，因此 MCP session 重连不会自动丢失，但服务重启会清空；它不提供执行、文件读取
或授权能力。当前仍未接入 ChatGPT prompt 自动装配、Cloudflare、长期持久化或自动 retrieval，
且尚未声明生产 runtime 已晋升。它解决的是“只传任务相关投影且保留事实锚点”的最小核心，
不代表任意数据可以无损高倍压缩。

## 已有机制承载的研究成果

### 影身理论与镜影协议

DevSpace 不新增第二套“影子数据库”。现有能力已经提供候选态与现实态的分离：`apply_patch`
`dryRun`、Git worktree、部署 stage/backup、review checkpoint 都属于 Shadow Candidate；SHA-256
`expectedHashes`、物理根 anchor、审批上下文 fingerprint、Codex turn evidence 属于 Mirror Evidence。
原则是候选可以失败，真实状态不能因候选验证失败被偷偷替换。

### Neuron Safety

工程生命周期采用 `Candidate -> Isolate -> Validate -> Promote -> Observe -> Repair/Degrade/Retire`。
它约束补丁、配置、Agent profile 和部署，不引入“检测异常就删除文件”的行为。删除、移动和
高风险晋升仍经过现有 Owner/工作区边界；测试通过也不等于已经部署或真实宿主已加载。

### Eterna 分层与 Zero / 灵曦

DevSpace Core 继续负责 workspace/files/process/git/review/MCP primitives；Personal Control Plane
负责 intent、route、policy、approval、evidence/recovery；机器专用 systemd、路径和 tunnel 属于
Local Deployment。`Zero` 只对应确定性不变量/验证角色，`灵曦` 只对应上层语义协调角色；二者
不是安全主体，也不能用人格或提示词覆盖代码中的权限检查。

## P1：有明确方向，但暂不伪造运行能力

- **概率命运坐标系 / MPG/MPE**：可用于未来风险与可逆性校准；当前没有标注数据和 Brier/可靠性
  校准，因此不输出“0.81 风险”之类伪精度数字。现有离散风险分类继续作为权威规则。
- **竹林网络 S/R/L/T**：对应 Stability、Recoverability、Load、Traceability。只有取得真实指标
  后才能加入 readiness；当前 `/readyz` 不合成虚假健康分数。
- **水态智能**：未来可依据 provider availability/load 重新计算可行路径，但执行一旦可能产生
  副作用，不自动流向另一个 provider 重跑；先进入 ReturnFlow reconcile。
- **Shadow Worlds / 镜像世界**：现有 Git worktree 可以承载多个隔离候选。未来可以比较多方案，
  但目前不自动生成多个分支或把模拟结果当成真实验证。
- **UnifiedBus / SynapseBus**：当前直接调用链仍清晰，不为了名称新增第二套权威事件状态。只有出现
  多消费者和可恢复事件需求时再引入事件总线。

## P2：保留研究接口，不进入关键执行路径

- **ColdLang**：优先作为 policy/routing/verification DSL 的候选，而不是另造通用语言；在 schema、
  parser、权限语义和迁移测试出现前不执行 ColdLang 文本。
- **梦语系统完整形态**：仅 Canonical Intent IR 子集进入运行时，其余保持研究层。
- **Resonance / 共鸣协议**：未来用于检查 Human Intent、Workspace、Agent、Runtime 是否同步；目前
  继续依赖显式 workspaceId、requestKey、fingerprint 和 runtime evidence。
- **Meta-World Model**：未来只能基于真实候选执行记录学习路径效果，不能把模型模拟当成现实 telemetry。
- **影子生命、意识/人格、QSM、ColdSound 等**：没有直接改善 DevSpace 执行安全或可验证性的成熟
  消费者，保持研究层，不进入权限、路由或删除决策。

## 不变量

1. `route != authority`：奇美拉/水态路由永远不能提升权限。
2. `candidate != live`：影身候选未经验证和晋升不能成为真实状态。
3. `simulation != evidence`：镜像世界和 Meta-World 不能替代真实测试与 runtime evidence。
4. `unknown != retryable`：回游首先观察和核对，不确定交付不能自动重放。
5. `score requires calibration`：竹林/概率指标没有真实数据就不输出数值。
6. `research name != implementation`：只有源码、测试、构建、部署和真实消费路径分别验证后，才声明
   对应层级已经实现。
