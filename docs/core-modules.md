# 核心模块与契约

本页描述 DevSpace 自身的模块，不公开被接入项目的目录或业务结构。

## 服务与工具入口

位置：[server.ts](../src/server.ts)、[tool-surfaces](../src/tool-surfaces)。

输入是 HTTP/MCP 请求，输出是工具结果或协议错误。该层负责组合认证、会话、
工具参数和 UI 元数据，不应承担具体项目业务逻辑。

工具 schema 更新、运行服务更新与宿主缓存刷新是不同步骤。接口是否可见，
必须与一次实际调用的结果区分。

## 本地部署入口

位置：[deploy.mjs](../scripts/deploy.mjs)、[local-server.mjs](../scripts/local-server.mjs)、
[deploy.cmd](../deploy.cmd)、[deploy.sh](../deploy.sh)。

部署器在尚未安装依赖时只使用 Node 内置模块。它复用 `init --local` 和现有配置
读写、应用创建与关闭模块，不另建认证或工作区状态。候选构建通过检查后才替换
`dist`；前台子进程通过本机 IPC 报告就绪，随后执行 HTTP 健康验证。

已有配置不自动重置，旧格式或不完整配置需要明确处理。就绪只证明本地服务
启动，不代表公网、模型或项目全量读写都已验收。

## 配置与认证

位置：[config-schema.ts](../src/config-schema.ts)、[config.ts](../src/config.ts)、
[oauth-provider.ts](../src/oauth-provider.ts)、[oauth-store.ts](../src/oauth-store.ts)。

配置使用版本化 JSONC 和 schema 校验。认证数据与普通配置分离，令牌生命周期
由 OAuth 提供方与存储负责。公开示例只能包含占位域名和无秘密的结构。

配置加载成功不等于所选模型、网络或回调地址实际可用。

## 工作区与路径

位置：[workspaces.ts](../src/workspaces.ts)、[workspace-store.ts](../src/workspace-store.ts)、
[roots.ts](../src/roots.ts)。

输入为已授权项目路径或已有工作区身份，输出为操作上下文、指令发现和状态。
checkout 复用与 worktree 创建有不同生命周期。逻辑路径、物理路径和根目录
锚点必须一致，不能通过旧标识访问已改变目标的目录。

指令扫描具有预算。发现不完整时必须报告，并由调用方补查目标目录的祖先说明。

## 项目访问

位置：[project-access.ts](../src/project-access.ts)、[project-tools.ts](../src/project-tools.ts)。

主要接口为 `project_files`、`project_search`、`project_read`，相应能力也可
通过项目 CLI 使用。

- 文件清单返回相对路径、分页游标、快照和覆盖状态。
- 搜索返回匹配位置、片段及文件哈希，是大小写敏感的字面量搜索。
- 读取返回 UTF-8 文本、SHA-256、字符偏移和完成标记。

游标绑定操作及范围，不能由调用方编造。读取偏移是 UTF-16 字符位置，不是行号。
文本上限为 8 MiB；二进制、非 UTF-8 以及发现排除项需要明确报告。

## 补丁执行

位置：[apply-patch.ts](../src/apply-patch.ts)。

输入为补丁及可选的预览、哈希约束。准备阶段解析全部操作并检查初始内容；
启用 `expectedHashes` 时需覆盖每个受影响源路径及目标路径，新文件使用 `null`。

预览不会写文件。正式执行会进行内容替换，并返回文件级结果和差异统计。
多文件写入不具备数据库式事务语义，后续文件失败时应检查此前文件的实际状态。

## 命令与审查

位置：[process-sessions.ts](../src/process-sessions.ts)、
[review-checkpoints.ts](../src/review-checkpoints.ts)。

命令执行返回输出、退出码或可继续获取结果的进程会话。输出截断必须显式处理。
差异审查使用 Git 支持的检查点；并行发生的改动可能进入同一审查范围，不能
把汇总结果全部归因于最后一个工具调用。

## 桥接与任务管理

位置：[codex-bridge.ts](../src/codex-bridge.ts)、
[local-agent-client.ts](../src/local-agent-client.ts)、
[local-agent-manager.ts](../src/local-agent-manager.ts)。

桥接提供 `codex_preflight`、`codex_task_start`、`codex_task_continue`、
`codex_task_status`、`codex_tasks`。它负责显式交付、请求去重和结果展示。

管理器负责目标解析、任务状态、档案权限上限及策略校验。请求已记录、任务在
运行和结果可接受是不同条件，必须分别验证。

## 守护进程与提供方适配

位置：[local-agent-daemon.ts](../src/local-agent-daemon.ts)、
[local-agent-daemon-protocol.ts](../src/local-agent-daemon-protocol.ts)、
[local-agent-runtime-pool.ts](../src/local-agent-runtime-pool.ts)、
[local-agent-codex.ts](../src/local-agent-codex.ts)。

守护进程通过本机 IPC 供 CLI 和 MCP 服务复用，运行池管理可释放的提供方资源。
逻辑任务持久化，但执行进程可以重建。不同提供方的能力和权限实现需要分别验证。

受保护 Codex 轮次结束后释放进程，后续从持久会话恢复，以避免继承旧的已加载
权限。这个策略增加启动成本，不能描述为无成本的缓存复用。

## 运行证据与持久化

位置：[local-agent-execution.ts](../src/local-agent-execution.ts)、
[local-agent-store.ts](../src/local-agent-store.ts)、[db](../src/db)。

执行策略可规定精确模型及最低 CLI 版本；完成结果需要对应轮次的模型与权限
证据，而不是助手自报。运行记录读取有时间和大小限制，缺失证据时拒绝结果。

SQLite 保存任务等持久状态；运行进程、连接和内存互斥不因写入数据库而自动
获得跨进程事务保证。数据库结构演进、回执保留和错误恢复应独立维护。

## 工程边界

各模块通过明确输入输出协作，不应新增第二套工作区身份、隐式后台对话循环或
无法审查的状态副本。增加能力前先查找已有模块，修改共享契约前检查消费者。

参考：[架构与请求流](architecture.md)、[开发流程](chatgpt-coding-workflow.md)、
[代理档案](agent-profile-schema.md)、[本地守护进程](local-agent-daemon.md)。
