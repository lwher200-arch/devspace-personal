# WebCodex 能力融入 DevSpace

本轮参考 [WebCodex v0.4.0](https://github.com/yyjeqhc/webcodex/tree/v0.4.0) 的
[开发流程](https://github.com/yyjeqhc/webcodex/blob/v0.4.0/docs/CODING_WORKFLOW.md)
和 MCP 原生进程、批量文件读取契约，将适合的行为实现到 DevSpace 自身的模块中。
版本依据为上游 commit `0991258952e6ac8b10de48423e26c52e65e0b6dd`。

实现沿用 DevSpace 的 workspaceId、路径守卫、读取哈希、ProcessSessionManager、
Owner 审批与 show_changes。没有复制上游 Rust 源码、引入 WebCodex 运行依赖，
也不需要安装或启动 WebCodex Server/Runner。新增接口采用 DevSpace 的 camelCase
参数和 UTF-16 分页约定。

## 批量有界读取

已知道要读的文件时，调用 `project_read_batch`：

```json
{
  "workspaceId": "实际已打开的工作区标识",
  "items": [
    { "path": "AGENTS.md", "limit": 6000 },
    { "path": "src/example.ts", "offset": 0, "limit": 10000 }
  ],
  "maxResultBytes": 65536
}
```

一次接受 1–8 项。`offset`、`limit` 和 `expectedSha256` 与 `project_read` 相同；
偏移是 UTF-16 字符位置，不是行号。`maxResultBytes` 范围为 8192–262144，约束
序列化后完整批量结果的 UTF-8 字节数，包含转义、路径、状态与续读元数据；它不是
HTTP/MCP 传输包或宿主上下文的总字节限制。

返回 `results` 保留请求顺序和本批次的 `index`。成功项带单文件读取字段；失败项
返回 `status: "error"` 和错误码。`continuation` 给出下一次同工具调用应使用的
items 与预算，调用时继续带原 workspaceId。已观察文件的续页保留 expectedSha256。

`complete` 为 false 时核对 `continuation` 和 `hasErrors`。缺失文件、格式不支持
和哈希变化需要分别处理；HASH_MISMATCH 的 recovery 只用于重新观察文件，取得
新证据后再决定修改，不能把旧补丁的守卫直接清除。整批不是多文件原子快照。

服务会在读取正文之前检查所有路径；MCP 授权也遍历每一项。因此将 `.env` 等
敏感文件混入普通读取不会绕过原有审批。路径越界仍被拒绝。

CLI 可从项目内的 UTF-8 JSON 文件读取相同请求（不含 workspaceId）：

```text
devspace project read-batch --request-file batch-request.json --json
```

## 原生进程与同次执行续读

调用 `run_process` 传入 executable 与字面参数：

```json
{
  "workspaceId": "实际已打开的工作区标识",
  "executable": "python",
  "args": ["-m", "pytest", "tests/test_example.py", "-q"],
  "workingDirectory": ".",
  "timeoutMs": 60000,
  "yieldTimeMs": 10000,
  "maxOutputTokens": 4000
}
```

有虚拟环境时，executable 应使用该环境的真实 Python 路径。参数中的空字符串、
空格、引号、中文、`&`、`%NAME%` 等原样传给进程；没有 Shell 变量展开或重定向。
Windows `.cmd/.bat` 不属于这个入口的支持对象。确需 Shell 语义时继续使用原有
`exec_command` 或 `bash`，并遵守相同的授权要求。

最多 256 个参数，单项最多 8192 个字符；executable 与 argv 加边界共最多
16000 UTF-8 字节。可选 `stdin` 最多 65536 UTF-8 字节，写入一次后关闭；省略
stdin 也会关闭输入。原生会话不接受后续普通输入，交互工作仍使用已有 Shell/PTY。

`timeoutMs` 默认 60000、上限 3600000；这是总运行预算。`yieldTimeMs` 只控制
本次等待多久，不能延长运行期限。运行未结束会返回 sessionId；用 `process_status`
继续读取同一会话，或用 `process_cancel` 请求终止它及其进程树，均需原 workspaceId。
取消或超时请求后如仍有 `running: true`，继续观察状态，不能宣称进程已经退出。

回执保留稳定 executionId、实际 cwd、exitCode/signal、timedOut、cancelled、
spawnError/stdinError 和输出截断状态。非零退出、启动失败、stdin 失败、超时或取消
不会当作成功。零退出只证明该命令的结果，不能自动证明测试被发现或业务路径有效。

状态轮询消费增量输出，不重启工作；不要为了等结果再次调用 run_process。完成后
最终读取会移除会话，未读取的完成会话按既有期限清理。MCP 连接重建可以继续同一
服务实例的会话；服务重启会丢失这些内存会话。本轮没有实现持久 Job、重启恢复、
执行结果账本或自动重放。

run_process 和 process_cancel 仍属于高风险操作；process_status 是只读轮询。
`shell:false` 只确定参数语义，并不提供文件系统、网络或模型沙箱。

## 显式刷新项目上下文

支持 conversation checkout 复用的宿主，可以对相同项目路径调用：

```json
{ "path": "~/work/my-project", "refreshContext": true }
```

这会重新返回当前项目指令、嵌套指令发现、技能及代理目录，并保留该对话的
checkout workspaceId。默认重复调用仍省略重复上下文。宿主未提供支持的对话
绑定时，继续用已有 workspaceId 读取规则；普通 open_workspace 不保证跨宿主复用。
`refreshContext` 与 `mode: "worktree"` 组合会被拒绝，避免刷新动作创建额外工作树。

刷新指令不是改变授权。指令发现仍有既有扫描预算，缺失或截断需继续读取；本轮
没有增加无限项目扫描或完整项目语义索引。

## 使用与升级边界

完整流程沿用：open_workspace → 读取/搜索 → 受保护修改 → run_process/续读验证
→ show_changes。新增能力在 Claude 和 Codex 两种工具模式中均可用；原工具名字
和参数保留。既有 OAuth、Owner、模型路由、根目录与持久化格式不需要迁移。

源代码修改、候选构建验收、运行服务更新和宿主工具缓存刷新分别验证。运行服务
更新后，宿主还可能需要刷新连接元数据。当前已验证范围见 [开发日志](../CHANGELOG.md)。
多机器 Runner、Tunnel 管理、WebCodex task-v1 审查、持久工作流账本等不在本轮范围；
后续若引入，应先单独设计身份、恢复和权限契约，避免制造第二套状态所有者。
