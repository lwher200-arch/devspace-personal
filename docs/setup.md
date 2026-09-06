# 部署与使用

本页只描述通用步骤。所有目录和域名都是虚构示例，不对应实际项目。

## 环境要求

- Node 版本满足 `package.json` 的 `engines`。
- pnpm 版本与 `packageManager` 一致。
- Git 和兼容的 Bash 环境；Windows 可使用 Git Bash 或 WSL。
- 需要代理委派时，另行安装并验证所选择提供方的执行程序。
- 需要远程 MCP 访问时，准备自己控制的 HTTPS 入口。

Shell、文件工具和提供方执行器是不同路径，必须分别验证。

## 构建源码

```sh
git clone https://github.com/lwher200-arch/devspace-personal.git
cd devspace-personal
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

后续 `node bin/devspace.js` 命令从此仓库目录运行。文档中的 `devspace` 简写
表示同一份源码构建，不表示另行下载某个发行包。

## 初始化

```sh
node bin/devspace.js init
```

只授予需要访问的目录，例如 `~/projects/workspace-a`。不要把整个用户目录或
磁盘作为方便修复错误的替代方案。直接代理 CLI 与 MCP 文件操作使用不同的
上下文入口，应分别理解其权限范围。

配置与认证分开保存：

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

认证文件仅在本机保存，不提交、截图或粘贴到公开问题中。

## 启动与检查

```sh
node bin/devspace.js doctor
node bin/devspace.js serve
```

默认健康接口是 `http://127.0.0.1:7676/healthz`，MCP 接口是
`http://127.0.0.1:7676/mcp`。健康检查不等于账户连接、文件修改或代理执行验收。

## 远程入口

HTTPS 反向代理应转发整个服务，OAuth 发现和授权路径也需要可达。
DevSpace 本身不创建或管理隧道。

配置中的地址使用 origin：

```sh
node bin/devspace.js config set publicBaseUrl https://devspace.example.com
```

MCP 客户端使用 `https://devspace.example.com/mcp`。未携带令牌请求受保护
接口返回认证挑战是正常行为，不通过关闭认证、放开所有 Host 或跳过证书
验证来消除它。

## 可选代理能力

显式启用需要的提供方，核对实际执行程序与模型可用性。桥接默认关闭，写入
默认不开放；需要时在私有配置中启用，参见 [配置参考](configuration.md)。

仓库包含 `skills/subagents` 和 `skills/devspace-closed-loop`。使用宿主支持的
本地技能加载方式接入当前检出的版本，不把其他来源的安装提示当作本仓库版本。

## 最小验收

1. 检查本机健康接口。
2. 检查 HTTPS 入口及 OAuth 发现。
3. 用真实客户端打开已授权工作区并读取说明文件。
4. 在明确的测试目录预览补丁、修改测试文件并回读哈希。
5. 运行相关测试并核对退出码。
6. 需要代理委派时，再独立验证模型、完成状态和运行证据。

逐项报告结果，不把前一步成功作为后一步的证明。

## 更新与恢复

升级前保留代码版本、私有配置和状态备份。不要用示例覆盖运行配置，也不要
在数据库有写入进程时恢复 SQLite 文件。网络切换、睡眠或重新登录后，应
再次验证公网连接，而不只检查进程是否存在。

专用部署脚本和真实环境拓扑不公开。更多诊断方法见 [故障定位](gotchas.md)。
