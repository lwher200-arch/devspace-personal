# 工具目录与输入输出边界

本页描述服务端能力，实际列表由模式、桥接、UI、平台和授权配置决定。宿主缓存中的
列表可能落后于运行服务，不能仅凭看到工具名称判断认证或执行成功。

## 两种基础模式

- `codex`：`open_workspace`、`read`、`apply_patch`、`exec_command`、`write_stdin`、`show_changes`。
- `claude`：`open_workspace`、`read`、`write`、`edit`、`bash`、`show_changes`。

两种模式都注册下列项目工具与原生进程工具，不需要为了使用它们启动 Codex 推理。
`grep`、`glob`、`ls` 不是独立注册工具，可用专用项目搜索或受控命令完成相应操作。

## 公共项目工具

- `project_files`：默认每页 200、最多 500 路径；继续 `nextCursor`，同时检查 `coverage.complete`。
- `project_search`：区分大小写的字面量搜索，默认 50、最多 100 匹配；可能返回空页但仍有续页。
- `project_read`：UTF-8 常规文本，文件上限 8 MiB；默认 12000、最多 20000 UTF-16 单位，JSON 文本另有字节预算。
- `project_read_batch`：一次 1–8 项；默认完整结果预算 65536 B，可设 8192–262144 B；按每个文件的哈希和续读信息继续。
- `context_fabric`：单一低 schema 上下文入口。`put_anchor` 保存 workspace-scoped 内存 Anchor，`append_delta` 追加单调序列 Delta，`capsule` 按预算 materialize EvidenceRef 约束的当前 ContextCapsule。状态不跨服务重启，不提供文件访问、执行权或授权能力。
- `control_hub`：固定 Cloudflare Control Hub relay 入口。当前仅提供 `status`、`hello`、`permissions`、`notifications`；端点和节点凭证来自本地环境变量，工具不会返回 Token，也不能把云端协调权限转换为本地执行权限。未配置 `DEVSPACE_CONTROL_HUB_URL` 时 `status` 只返回未配置状态，不发网络请求。

发现排除依赖、生成内容、疑似凭据名称和链接目录，具体排除与扫描截断会返回给调用方。
批量读取是多份独立观察，不是全项目原子快照。内容变更后不能移除哈希继续应用旧补丁。

## 修改与进程

`apply_patch` 支持 `dryRun` 与覆盖所有源/目标路径的 `expectedHashes`。新路径以 `null`
表达“必须不存在”。预检不是操作系统级多文件事务，执行失败后仍需回读实际文件状态。

`exec_command` / `bash` 使用 Shell；在配置了 `WorkspaceExecutionBoundary` 时，项目命令通过同一工作区执行边界启动，`write_stdin` 继续服务于已有 Shell/PTY 会话。当前 Linux 默认启动路径创建 Bubblewrap v4 profile，将主机文件系统设为只读、工作区设为可写、隐藏当前用户 `/run/user/$UID` 控制面并屏蔽常见宿主凭据和控制 socket，同时隔离 PID/UTS/IPC、过滤敏感环境变量。普通逐次批准的执行继承网络，内部 A2 Candidate 执行使用禁网配置。A2 租约申请/激活入口尚未向普通客户端开放，不能将普通批准视为 A2 授权。

未配置执行边界的实例会明确保留服务账户权限语义，不能标记为已隔离。`host_command` 是独立的 Owner-gated 主机维护/恢复平面，不经过项目执行边界。

- `host_command`：面向 DevSpace 所在 Ubuntu 主机的维护/恢复 Shell，适合 `systemctl`、`journalctl`、`ss`、`ps`、网络和服务诊断；它不是沙箱，默认进入 Owner 审批。若用户显式选择本对话受限授权，只复用完全相同的完整请求。
- `run_process`：原生 executable 与字面 argv，不经过 Shell 解析；默认运行预算 60000 ms，上限 3600000 ms。
- `process_status`：读取同一 `run_process` / `host_command` 原生会话的增量输出和结果，不启动第二次执行；读取会消费输出。
- `process_cancel`：请求终止同一 `run_process` / `host_command` 原生进程树；若仍为 running，继续查询，不能把请求取消当作已退出。

原生进程最多 256 个参数，每项最多 8192 字符，executable/argv 合计最多 16000 UTF-8 B。
初始 stdin 最多 65536 B，发送后关闭。Windows `.cmd/.bat` 需明确使用 Shell 入口。
原生进程会话不跨服务重启恢复，完成后的最终读取会移除会话。

## 条件能力

启用 `bridge.enabled` 后可使用 `codex_preflight`、`codex_task_start`、
`codex_task_continue`、`codex_task_status` 和 `codex_tasks`。它们是显式任务交付接口，
不是接管任意桌面窗口。预检不启动推理；请求键处理重试；状态查询等待最多 20 秒。

配置 Owner 授权和 UI 后提供 `review_approval`、app-only 的 `decide_approval`、审批收据交接用的
`claim_approval`、拒绝后重新申请用的 `reissue_approval`，以及只会收紧权限的
`revoke_conversation_approvals`。后三个控制工具显式对模型可见，但不绑定 widget/output template；
`claim_approval` 只用于宿主 logical session 漂移后的收据迁移，同一会话批准后先直接重试原操作。审阅工具可展示卡片，但不批准操作；
决策需要当前可信客户端、对话和私有单次凭据。非 Codex 卡片固定显示“本对话内始终同意安全操作”，
其租约只覆盖服务端定义的安全 review/worktree 范围和用户明确批准过的精确原生命令；模型不能自行开启。
不得由模型代替用户调用批准入口。缺少宿主支持时保留 Owner 页面。

`download_artifact` 还要求显式启用下载且运行在支持的平台；当前安全下载实现仅在 Linux 注册。

## 可视化与权限不是同一个开关

默认基础界面卡片用于 `open_workspace` 与 `show_changes`；启用审批后还有专用审批卡片。
关闭 UI 不取消已有命令或文件工具，也不绕过 Owner 网页授权。

普通权限策略、敏感路径、删除/移动、任意执行和代理委派的具体分类，以
[授权说明](authorization.md) 为准。只读提示、工具名称和“运行测试”等自然语言标签都不是授权。
