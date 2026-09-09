# 文档导航与维护边界

本目录描述 DevSpace Personal 的公开产品契约，不记录实际接入项目、账号或部署拓扑。
源码、受测提交、运行构建和宿主工具清单是不同的状态，不能互相代替验收。

## 从哪里开始

- [部署与步骤引导](setup.md)：源码安装、候选构建、配置与启动。
- [ChatGPT 开发流程](chatgpt-coding-workflow.md)：发现、读取、修改、执行及回读。
- [工具目录](tool-reference.md)：基础模式、公共工具和条件注册的能力。
- [配置参考](configuration.md)：JSONC、Schema、默认值和旧格式迁移。
- [授权与模型路由](authorization.md)：单次批准、30–120 分钟窗口与独立登录期限。
- [故障定位](gotchas.md)：区分网络、身份、工作区、执行和证据错误。

## 理解系统

- [架构与请求流](architecture.md)：分层、生命周期、状态归属和不变量。
- [核心模块](core-modules.md)：源码入口及依赖责任。
- [代理桥接](closed-loop.md)：请求去重、模型证据及有限往返。
- [守护进程](local-agent-daemon.md) 与 [代理档案](agent-profile-schema.md)：执行与权限契约。
- [原生进程和批量读取](webcodex-adoption.md)：参数预算、续读及兼容限制。
- [用量说明](token-usage.md)：提供方回执与完整账单之间的区别。
- [文件交换](artifact-exchange.md)：可选下载入口。
- [安全模型](security.md) 与 [公开文档隐私规范](public-documentation.md)：数据流和信任边界。
- [工程维护与演进](maintenance.md)：验证门禁、发布纪律和待处理架构问题。

## 文档也是契约

文档中的示例是虚构数据。配置示例由 Schema 测试校验；工具目录应随工具注册同步。
`npm run test:docs` 检查根目录及 `docs`、`examples`、`skills` 下的 Markdown 链接，并运行检查器测试。
它不执行代码示例、不抓取外部网页、不证明标题锚点或真实宿主流程可用。

日期化的 [开发日志](../CHANGELOG.md) 是历史验证记录，不是当前部署状态面板。
新版本发布后仍需另行核对实际服务、守护进程和宿主连接。
