# 用户授权与双模型路由

Chat/MCP 入口、Owner 确认页面和本机 Codex 工作进程是不同的权限层。
这里的“入口”不是新增不受保护的端口。Codex app-server 继续使用本机 stdio，
DevSpace 继续使用已有 HTTP/MCP 与 OAuth 入口。

## Chat 入口

在 `config.jsonc` 中启用：

```json
{"tools":{"mode":"codex","authorization":"owner_approval"}}
```

新建的 `init --local` 配置默认启用此模式。旧配置缺省仍为 `legacy`，升级代码
不会静默改变已有客户端行为；旧部署应由用户明确开启，并重启服务。

常规发现、普通文件读取、任务状态查询和带完整 `expectedHashes` 的小批量
普通文件补丁可直接使用。任意 Shell、向进程写入字符、删除/移动、超过 20 个
补丁操作、缺少哈希的修改、凭据及权限/执行配置访问、Codex 写入轮次和未知
工具需要 Owner 授权。聚合差异查看和只读代理任务也需要确认：聚合结果可能
包含受保护文件，只读代理的沙箱也不等于只能读取工作区。常规项目发现和搜索
会排除 SSH、云凭据及 Codex 私有目录。只读补丁预览不写入，但访问受保护文件
仍需批准。

1. Chat 收到 `OWNER_APPROVAL_REQUIRED` 和 `approvalUrl`，此时操作尚未执行。
2. 用户自己打开地址，核对工具、完整参数、路径/文件指纹和选定模型。
3. 在该页面输入 Owner 密码，选择单次同意或拒绝。不要把密码交给 Chat。
4. 对 `codex_task_start` / `codex_task_continue`，批准会自动提交刚刚展示的
   一个轮次，无需回 Chat 重试才能启动。审批页会跳转到提交状态，显示任务编号；
   提交不等于完成，Chat 用 `codex_task_status` 查询结果，编号遗失时用
   `codex_tasks` 恢复。服务不会自行唤醒 ChatGPT 或创建新的聊天轮次。
5. Shell、补丁及其他高风险操作仍需回 Chat 重试完全相同的操作。
   修改参数、文件内容、工作区、OAuth 客户端或宿主提供的逻辑会话后需要新授权。
   MCP 传输连接重建不改变审批身份。一次同意仅允许执行一次，不形成永久提权。

### Codex 批准后的状态

`pending -> submitting -> submitted | failed`；拒绝为 `pending -> denied`。
只有通过 Owner 密码、Origin、Cookie/nonce 和有效期校验的批准才能进入提交。
提交前重新验证原 OAuth token、工作区边界及审阅上下文，复用工具的同一输入
schema 和 CodexBridge 的持久化 `requestKey` 去重，不新增执行队列或后台对话循环。

旧客户端批准后再次发送完全相同的请求，会收到 `OWNER_OPERATION_SUBMITTED`
及 `agentId` / `workspaceId`，而不是再次执行或生成新授权。提交期间返回
`OWNER_OPERATION_SUBMITTING`。收据在内存中保留五分钟，此后或服务重启后应
使用 `codex_tasks` 恢复已经持久化的任务，而不是创建新的 `requestKey`。

若出现 `OWNER_SUBMISSION_UNCONFIRMED` 或页面显示提交未确认，可能是凭据失效、
工作区/模型上下文改变，或交付失败。不要自动换模型、重新批准或重发；先查看
该工作区的任务和服务日志。交付不确定时沿用现有桥接恢复规则，避免重复执行。

未消费的授权五分钟过期，服务重启后失效；已提交任务不因此取消或重放。
拒绝的请求不会自动转为同意。页面要求
同源提交、浏览器 Cookie/nonce 和 Owner 密码，日志不记录密码或完整参数。
请求数量与总大小均有限制，超过限额需处理已有请求或等待其过期。

审批页使用 `Referrer-Policy: same-origin`，以便浏览器正常提交同源 Origin，
同时不把审批地址放进跨站 Referer。不要改回 `no-referrer`：浏览器表单 POST
可能因此携带 `Origin: null`，并被来源校验拒绝。来源为空、`null`、跨站，
或缺少正确 Cookie/nonce 的提交仍被拒绝；代理转发头不能替代浏览器 Origin。
该校验发生在 POST 提交阶段。过期或已决定的链接在 GET 时返回不可用。

浏览器回归使用独立临时配置和无实际操作的测试请求，不使用用户的 Owner 密码。
运行 `src/mcp-authorization.browser.test.ts` 时，设置 `DEVSPACE_TEST_BROWSER`
为已安装 Chromium 的完整路径；Windows CI 会显式执行此项。

这不是操作系统沙箱，也不是可靠识别所有危险代码的分类器。Shell 一律请求
批准，因为 `npm test` 等看似普通的命令也能执行项目代码。用户批准 Shell 后，
命令仍具有服务账户的文件与网络权限。普通代码修改后若被其他本机进程自动
执行，也不受此 MCP 入口控制；高隔离需求应使用独立账户或虚拟机。

## Codex 路由

启用桥接时，可以采用以下策略；提供方登录和可用性需独立验证：

```json
{
  "bridge": {
    "enabled": true,
    "allowWorkspaceWrite": true,
    "executionPolicy": {
      "requiredModel": "gpt-6-astra",
      "minimumCliVersion": "0.153.0",
      "allowedModels": ["gpt-6-astra", "gpt-5.6-sol"],
      "routing": {
        "routineModel": "gpt-5.6-sol",
        "complexModel": "gpt-6-astra"
      }
    }
  }
}
```

可显式传入其中一个模型，或使用 `model: "auto"`；仅配置路由时省略模型也会
进行选择。规则是可审查的启发式，不是额外的模型调用：长任务，以及包含
架构、重构、安全、并发、迁移、根因等提示的任务优先复杂模型，其余使用常规模型。
显式选择优先。任务回执和持久记录保留实际选择；调度规则不改变写入权限。

两模型都在允许清单中，不代表执行中可以互相替换。每轮必须验证所选模型的
账号可用性、会话模型、实际轮次证据和沙箱；缺失证据、版本过低、账号不可用、
失败或执行中换模型都停止，不自动降级或重复可能已经写入的任务。

双模型策略需要 `executionPolicyVersion >= 2` 的本机守护进程。旧单模型策略
继续兼容；旧任务保留原策略，不能在续接时扩展其权限或模型清单。改变策略后
应新建任务，而不是修改历史任务记录。`read_only` reviewer 仍保持只读。

模型清单可参见 [OpenAI Models](https://developers.openai.com/api/docs/models)，
实际本机访问资格以提供方预检和真实运行证据为准，而不是文档或配置中的名称。
