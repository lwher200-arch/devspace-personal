# 用户授权与双模型路由

Chat/MCP 入口、Owner 确认页面和本机 Codex 工作进程是不同的权限层。
这里的“入口”不是新增不受保护的端口。Codex app-server 继续使用本机 stdio，
DevSpace 继续使用已有 HTTP/MCP 与 OAuth 入口。

## Chat 入口

### 高危确认与 12 小时登录

可显式配置：

```json
{"tools":{"authorization":"owner_approval","approvalProfile":"high_risk_only","approvalTtlSeconds":1800},"oauth":{"ownerSessionTtlSeconds":43200}}
```

`high_risk_only` 让普通文件读写、编辑、小批量非敏感补丁及工作区创建按原文件
边界自动通过；仍建议使用 SHA-256 保护共享文件。删除、移动、大批量/大文件修改、
凭据与安全/执行配置访问，以及权限范围无法可靠收窄的能力继续逐次申请。
**任意 Shell、进程输入、聚合敏感差异和通用 Codex 委派目前仍属于这类高危能力。**
现有委派不能逐项拦截内部动作；不能只凭“运行测试”“普通编程”等描述就放行。
这不是完整实现的代理内部风险审批，后续需单独接通该执行边界。

登录验证与操作批准分离。Owner 密码验证有效期固定为 12 小时，不因使用、
刷新令牌或服务重启滚动延长。新的访问/刷新令牌保留原验证时间并受同一截止时间
限制；它们仍作为不透明凭据进行整串哈希存储，不增加数据库迁移。浏览器通过
带签名、HttpOnly、SameSite 和 HTTPS Secure 属性的会话 Cookie 记住已验证身份，
Owner 兼容页面在有效期内只需点击批准，不必再次输入密码。Cookie 自身不批准操作。
OAuth 使用 Cookie 重复确认连接时还校验 Origin 和绑定表单的 CSRF 证明。

`tools.approvalTtlSeconds` 控制任务待审批及未消费授权的有效期，默认 1800 秒
（30 分钟），只接受 1800–7200 秒的整数，最长 2 小时。截止时间从首次请求创建
起固定计算；重复打开页面、查看卡片或重试同一请求都不续期。Owner 页面 Cookie
和显示的到期时间与请求一致，不再保留独立的 5 分钟 Cookie。配置缺省的旧部署
升级后采用 30 分钟，无需修改配置文件；此变化不影响 12 小时登录验证期限。

单次批准仍只允许原始操作。参数、文件或模型上下文变化仍需重新审批；正在提交
或已启动的任务不会因为审批窗口到期被取消，这不是任务执行超时设置。服务重启
仍会清除内存中的待审批请求；扩大窗口不意味着审批持久化或永久授权。

启用固定验证期限后，无法证明验证时间的旧令牌会要求重新登录一次；客户端注册
及 Owner 密码不删除、不重置。到期后新的调用/刷新需重新验证，已启动任务不会
被伪装成取消。回滚应恢复原配置及构建，不必删除 OAuth 数据库。
这些是 DevSpace 的规则，不能关闭 ChatGPT 宿主自己的必要确认。

默认 `approvalProfile` 为 `conservative`，未配置 `ownerSessionTtlSeconds` 的旧
部署保持原登录策略。不要仅调大访问令牌 TTL 来替代固定密码验证期限。

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
2. 已启用 Chat 审批的客户端调用 `review_approval` 展示卡片；否则用户自己打开
   Owner 地址。核对工具、完整参数、路径/文件指纹和选定模型。
3. 在卡片中选择单次批准或拒绝。Owner 兼容页面仅在登录身份需要重新验证时输入密码，不要把密码交给 Chat。
4. 对 `codex_task_start` / `codex_task_continue`，批准会自动提交刚刚展示的
   一个轮次，无需回 Chat 重试才能启动。审批页会跳转到提交状态，显示任务编号；
   提交不等于完成，Chat 用 `codex_task_status` 查询结果，编号遗失时用
   `codex_tasks` 恢复。服务不会自行唤醒 ChatGPT 或创建新的聊天轮次。
5. Shell、补丁及其他高风险操作仍需回 Chat 重试完全相同的操作。
   修改参数、文件内容、工作区、OAuth 客户端或宿主提供的逻辑会话后需要新授权。
   MCP 传输连接重建不改变审批身份。一次同意仅允许执行一次，不形成永久提权。

### 在 Chat 内人工确认

可以为明确受信任的 OAuth 客户端启用审批卡片，减少每次输入 Owner 密码的操作：

```json
{"tools":{"authorization":"owner_approval","chatApprovalClientIds":["your-approved-chatgpt-client-id"]},"ui":{"enabled":true}}
```

列表默认为空，旧部署仍使用 Owner 页面。`OWNER_APPROVAL_REQUIRED` 中的
`chatApproval.clientId` 是服务端从已验证 OAuth 请求得到的客户端标识，不是密码。
仅在本机配置中加入你明确授权、能够将工具结果 `_meta` 与模型隔离的客户端，
不要按自报的 `clientInfo` 或 User-Agent 自动信任客户端。重新注册连接可能生成
新的客户端标识，此时需重新核对，不能自动扩展允许列表。

启用后，Chat 调用 `review_approval` 展示同一请求的完整参数和范围。你在卡片内
选择“批准一次”或“拒绝”，不需要把 Owner 密码交给 Chat。批准 Codex 请求会
复用已有的单轮自动提交；其他高风险操作仍只批准精确的一次重试。卡片会尝试
通过宿主消息桥通知聊天继续，不支持该桥时可以手动发送“继续”。这不是后台唤醒
任意聊天，也不会让新任务自动继承授权。

Chat 网页适配优先使用 MCP Apps 标准桥。标准能力不可用时，支持文档化的
`window.openai.callTool` / `sendFollowUpMessage` 兼容接口。桥接方式在调用前选定；
一次决定或通知交付不明时，不会换通道重发。恢复历史卡片不会自动发消息；用户
可点击“通知 Chat 继续”，先重新核验收据，再恢复结果查询，不重新批准或执行。

### 审批模式与失败状态

- 普通操作沿用已有规则直接处理，不增加权限。
- `chat_card` 要求被允许的 OAuth 客户端以及非空 `openai/session`。会话标识仅用于绑定，不取代 OAuth 和私有卡片凭据校验。
- 缺少可信客户端或聊天会话时使用 `owner_page`，不能把不同对话降级到一个空会话后共享卡片审批。

卡片读取及点击批准时都会重新核验当前工作区、目标文件指纹和选定模型。
上下文发生变化时返回 `APPROVAL_CONTEXT_CHANGED`，不先显示“已批准”再等待执行
失败；拒绝旧请求仍然可用。真正执行时的原有检查继续保留。

错误返回稳定代码：`CHAT_CLIENT_NOT_ENABLED`、`CHAT_CONTEXT_REQUIRED`、
`APPROVAL_UNAVAILABLE`、`APPROVAL_CONTEXT_CHANGED`。不存在、已过期、已使用或
不属于调用方的请求统一按不可用处理，不泄露别人的审批状态。日志仅记录请求
编号和错误码，不记录界面凭据、密码、完整参数或原始错误。网页会区分策略拒绝
与交付不明，禁止继续使用已失效的批准按钮。

服务端在组件专用 `_meta` 内发送单次界面凭据，`content` 和 `structuredContent`
不包含它。`decide_approval` 仅向 app 界面暴露，并额外验证凭据、OAuth 客户端、
原逻辑会话、请求和有效期；仅隐藏工具名称或传入 `approved: true` 都不构成授权。
卡片凭据不得进入日志、URL、聊天消息、模型上下文或持久化 widgetState。

只有展示工具 `review_approval` 声明输出模板。私有的 `decide_approval` 仅处理卡片点击，
保留 `ui.visibility: ["app"]`、私有可见性和卡片访问权限，但不设置 `ui.resourceUri`
或 `openai/outputTemplate`。否则 ChatGPT 可能提示“与模板关联的工具已隐藏”，并将
共享模板标记为不可用。不要通过把决定工具公开给模型或放宽权限来修复这个注册冲突。
修改后需刷新宿主的插件定义；服务端工具成功返回不代表宿主已恢复模板展示。

**信任边界：** 这项功能信任所选 MCP 宿主隔离私有元数据并承载用户交互，不是
独立于宿主的硬件签名或密码验证。能够控制受信任客户端、读取原始 MCP `_meta`
的程序也可能使用该凭据；不要为不可信宿主启用。移除客户端列表或关闭 UI 即撤销
卡片审批入口，原 Owner 页面仍然可用。刷新插件工具清单后再验收真实宿主行为。

普通读取、搜索和符合已有约束的小补丁继续按原规则执行。本功能没有新增自动
审批 Codex/Shell 的风险分类器，也没有开启任务级、会话级或永久授权。

### Codex 批准后的状态

`pending -> submitting -> submitted | failed`；拒绝为 `pending -> denied`。
只有通过 Owner 页面校验，或通过已启用的 Chat 卡片身份、会话、单次凭据、
上下文和有效期校验的批准才能进入提交。Owner 页面继续保留 Origin 和 Cookie/nonce 防护。
提交前重新验证原 OAuth token、工作区边界及审阅上下文，复用工具的同一输入
schema 和 CodexBridge 的持久化 `requestKey` 去重，不新增执行队列或后台对话循环。

旧客户端批准后再次发送完全相同的请求，会收到 `OWNER_OPERATION_SUBMITTED`
及 `agentId` / `workspaceId`，而不是再次执行或生成新授权。提交期间返回
`OWNER_OPERATION_SUBMITTING`。提交结果返回后，收据在内存中保留一个配置的审批窗口
（默认 30 分钟，最多 2 小时）；这是只读收据保留期，不重新授予执行权限。此后或服务重启后应
使用 `codex_tasks` 恢复已经持久化的任务，而不是创建新的 `requestKey`。

若出现 `OWNER_SUBMISSION_UNCONFIRMED` 或页面显示提交未确认，可能是凭据失效、
工作区/模型上下文改变，或交付失败。不要自动换模型、重新批准或重发；先查看
该工作区的任务和服务日志。交付不确定时沿用现有桥接恢复规则，避免重复执行。

未消费的授权按首次创建时的截止时间过期（默认 30 分钟，最多 2 小时），服务重启后失效；已提交任务不因此取消或重放。
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
