# Connector 原生 MCP、CLI 与 Skill 接入方案

Status: P0 implemented

## 1. 决策摘要

Connector Runtime 不再把 MCP、CLI 和 Skill 包装成 Tutti 私有的通用执行协议。
连接器只负责安装、鉴权、生命周期、运行时隔离和能力发现；Agent 按能力类型使用
原生机制：

- MCP 注册到 Agent 的本地 MCP client，通过标准 `tools/list` 和
  `tools/call` 使用。
- CLI 以连接器专属的稳定命令发布到 Agent 的 `PATH`，通过 shell 正常执行。
- Skill 通过 Agent 原生 Skill roots、scanner 和 reader 发现与读取。

公开的 Connector 发现命令最终只保留：

```bash
tutti connector available
```

下线以下四个公开命令：

```bash
tutti connector capabilities
tutti connector skills
tutti connector skill read
tutti connector invoke
```

首期不提供用户级 Connector 启停能力：

```bash
tutti connector enable --connector github
tutti connector disable --connector github
```

连接器是否注册由现有安装和鉴权状态决定：

- 已安装且当前账户鉴权就绪：注册运行时能力。
- 卸载、断开连接或鉴权失效：移除运行时能力。

## 2. 背景与根因

当前 ImplementationHost 已经具备两类上游 MCP client：

- managed stdio MCP client；
- remote Streamable HTTP MCP client。

两类 client 都会完成 `initialize`、`notifications/initialized` 和分页
`tools/list`。问题不在上游连接，而在上游工具注册之后的执行模型。

当前链路把每个 MCP tool 转换为 `connectorCommand`，注册进通用
`CommandRegistry`：

```text
上游 MCP
  -> 本地 MCP client
  -> connectorCommand
  -> connector capabilities
  -> connector invoke
```

这使标准 MCP 被降级成 Tutti 私有 RPC，带来以下问题：

- Agent 无法通过自己的 MCP client 感知连接器工具；
- MCP 的工具发现、schema、调用结果和动态列表通知被重复封装；
- CLI 也必须绕过正常 shell，统一提交 JSON 给 `connector invoke`；
- Skill 必须通过 `connector skill read` 兼容读取；
- Prompt 被迫指导 Agent 执行一套 Tutti 专属的发现和调用流程；
- `connector capabilities`、`connector skills` 与 MCP、Skill 原生发现能力重复。

第一个错误状态出现在 `registerMCPTools`：native MCP tool 在这里进入了
`CommandRegistry`，而不是进入 MCP Registry。修复必须从注册边界开始，不能只删除
CLI 命令或修改 Prompt。

### 2.1 WorkBuddy 对照结论

本机 WorkBuddy 的连接器 MCP 配置位于独立的
`~/.workbuddy-ai/connectors/default/mcp.json`，其中以 `mcpServers` 管理
`connector:<id>` 命名的连接器 Server；用户自定义 MCP 则位于根级 `mcp.json` /
`.mcp.json`。可复用的关键点不是文件格式本身，而是两条边界：

- Connector MCP 作为 MCP client 的原生 Server 配置进入 Agent，而不是转成私有
  invoke command；
- Connector-owned MCP 配置与用户自定义 MCP 分开存放、分开管理。

Tutti 沿用这两个边界，但结合现有 daemon Reconcile 和动态 route 生命周期，将所有
Connector-owned MCP 投影为一个本地 Server `connector`。这样 Agent 的 MCP 配置
稳定不变，安装、鉴权、升级和卸载只改变该 Server 的 `tools/list`；用户自定义 MCP
仍保留在各 Provider 原有配置中。

## 3. 目标和非目标

### 3.1 目标

- Agent 把 Connector MCP 当作普通 MCP Server 使用。
- 一个已运行的 Agent Session 能感知 Connector MCP 工具的动态增删。
- CLI 通过连接器专属命令直接执行，保持标准 argv、stdin、stdout、stderr 和退出码。
- Connector Skill 通过 Provider 原生 Skill 机制读取。
- 用户自定义 MCP 和 Connector MCP 完全隔离。
- 对外只保留一个无执行能力、无秘密信息的 Connector 发现命令。
- 延用现有 release、generation、鉴权和 Reconcile 生命周期，不重新设计安装体系。

### 3.2 非目标

- 首期不增加 `enable`、`disable`、`enabled` 持久化字段、API 或 UI。
- 首期不把用户自定义 MCP 聚合进 Connector MCP Server。
- 首期不扩展 MCP resources 和 prompts；先完成 tools 的原生接入。
- 不保留改名后的通用 invoke 命令。
- 不修改远端 Connector Market 的发布和签名协议。

## 4. 目标架构

```text
Connector Manifest / Installed Release
                 |
                 v
        ImplementationHost
          |             |
          |             +-------------------------------+
          v                                             v
  Upstream MCP Client                         Connector CLI Entrypoint
          |                                             |
          v                                             v
  ConnectorMCPRegistry                     stable connector-specific shim
          |                                  in Tutti state bin directory
          v                                             |
local Streamable HTTP MCP Server                        v
        name = connector                         Agent shell / PATH
          |
          v
    Agent native MCP client

Connector Skill directories
          |
          v
 Agent runtime extra Skill roots
          |
          v
 native Skill scanner / reader
```

正确的 MCP 执行链路为：

```text
上游 MCP
  -> Tutti 管理的上游 MCP client
  -> ConnectorMCPRegistry
  -> 本地 MCP Server "connector"
  -> Agent 原生 MCP client
  -> tools/list / tools/call
```

Connector Runtime 不再把 MCP tool 投影为 CLI capability。

## 5. Connector MCP Server

### 5.1 服务边界

公共 `packages/connector/runtime/mcpserver` 提供本地 Streamable HTTP MCP
Server；`tuttid` 在组合根中启动一个 daemon 生命周期实例：

```text
server name: connector
listen:      127.0.0.1:<dynamic-port>
endpoint:    /mcp/connector
```

该 Server 只投影 Connector Market 管理、当前运行状态有效的 MCP route。
用户通过 Provider 配置的自定义 MCP 不进入此 Server，也不进入
`ConnectorMCPRegistry`。

Server 即使暂时没有工具也保持运行并注入 Agent。连接器发生变化时只更新
`tools/list`，不修改 Agent 的 MCP Server 配置。

### 5.2 首期协议范围

本地 Server 同时提供两种 Agent-facing HTTP MCP 表面，并共享同一个
`ConnectorMCPRegistry`：

- Tutti modern client 使用 MCP `2026-07-28` 的无状态请求模型。每次调用都是一个
  独立的 `POST`，请求参数的 `_meta` 携带 protocol version、client info 和 client
  capabilities；HTTP header 同时携带 `MCP-Protocol-Version`、`Mcp-Method`，工具调用
  还校验 `Mcp-Name` 和 schema 声明的 `Mcp-Param-*`。
- Codex、Claude 和其他 Provider 原生 client 使用 MCP `2025-06-18` 的标准
  `initialize -> notifications/initialized -> tools/list -> tools/call` 链路。该表面还
  返回空的 `resources/list` 和 `resources/templates/list`，因为首期只投影 tools。

modern 表面实现：

- `server/discover`；
- `tools/list`；
- `tools/call`；
- `subscriptions/listen`，并通过 SSE 发送
  `notifications/subscriptions/acknowledged` 和
  `notifications/tools/list_changed`。

Provider 原生表面实现：

- `initialize`；
- `notifications/initialized`、`notifications/cancelled`；
- `ping`；
- `tools/list`、`tools/call`；
- `resources/list`、`resources/templates/list`，首期固定返回空列表。

两种表面都只接受 `POST`，不会在 daemon 内维护协议 Session。HTTP `GET` / `DELETE`
和 `MCP-Session-Id` 不属于首期范围；长连接只用于 modern
`subscriptions/listen` 的通知流。Provider 原生表面声明 `tools.listChanged=false`，
因此不会承诺尚未实现的原生 list-changed 通知。

上游 tool 的 `name`、`description`、`inputSchema` 和调用结果保持 MCP 语义，
只在本地聚合层增加连接器命名空间。

### 5.3 工具命名

本地工具名使用：

```text
<connectorKey>_<upstreamToolName>
```

例如：

```text
github_search_issues
notion_query_database
```

Agent 侧最终看到的完整工具标识由 Provider 决定，典型形式为：

```text
mcp__connector__github_search_issues
```

Registry 在提交前必须校验：

- connector key 和上游 tool name 均满足 canonical name 规则；
- 加前缀后不超过 MCP client 的工具名长度限制；
- 同一 generation 内无重名；
- input schema 是合法 JSON Schema 对象；
- 本地名可以无歧义地映射回 connector key 和上游原始 tool name。

不能通过静默覆盖处理冲突。冲突应使新 route 注册失败，并保留旧 generation。

## 6. ConnectorMCPRegistry

### 6.1 职责

新增独立的 `ConnectorMCPRegistry`，并将原 `CommandRegistry` 收敛为只保存
discover metadata 的 `RouteRegistry`。MCP Registry 保存经过验证的不可变 route
binding，至少包含：

```go
type ConnectorMCPRoute struct {
    ConnectorKey string
    Generation   uint64
    Client       MCPClient
    Tools        []ConnectorMCPTool
}

type ConnectorMCPTool struct {
    LocalName    string
    UpstreamName string
    Description  string
    InputSchema  map[string]any
}
```

Registry 提供：

- 按 generation 原子提交一个 Connector 的完整工具集合；
- 按 connector key 和 generation fence 移除 route；
- 生成稳定、排序后的 `tools/list` 快照；
- 将 `tools/call` 解析到不可变 route binding；
- 在列表发生实际变化后发布 list-changed 事件。

### 6.2 动态注册

注册流程：

```text
安装完成或鉴权就绪
  -> Reconcile 启动上游 MCP client
  -> initialize
  -> notifications/initialized
  -> 分页 tools/list
  -> 校验并构建完整 route
  -> 原子 Commit 新 generation
  -> 广播 notifications/tools/list_changed
```

更新流程：

```text
启动新 release
  -> 新 client 完成 initialize 和 tools/list
  -> 原子替换旧 generation
  -> 广播 tools/list_changed
  -> 关闭旧 client
```

新 route 未就绪前旧 route 始终可用，不允许先删后加造成工具空窗。

移除流程：

```text
卸载、断开连接或鉴权失效
  -> fence 当前 generation
  -> 从 Registry 移除 route
  -> 广播 tools/list_changed
  -> 关闭上游 client
```

`tools/call` 开始时解析不可变 binding，并在调用前验证 generation。命中已经
fence 的 route 时返回标准 MCP 错误，不回退到私有 CLI 调用。

现有 RouteTable 已有 generation-fenced Commit 和 Remove 语义，应复用其状态
模型，避免再建立一套独立生命周期状态机。

## 7. Agent MCP 感知

### 7.1 类型化运行时配置

当前 `PreparedRuntime` 只有 `Cwd` 和 `Env`，不能表达 MCP Server。新增统一的
类型化描述：

```go
type MCPServerBinding struct {
    Name    string
    Type    string
    URL     string
    Headers map[string]string
}
```

传递链路为：

```text
runtimeprep.PreparedRuntime
  -> agenthost.PreparedRuntime
  -> agentruntime.Session
  -> Provider adapter
```

不使用环境变量承载非类型化 MCP JSON，也不要求 Agent 自己执行
`connector available` 后再完成注册。

daemon 组合层在构造 Agent Service 和 Host 之前创建一个稳定的
`ConnectorRuntime` 端口。端口背后的 Registry 可以随 Reconcile 动态变化，但
Agent 恢复流程始终持有同一个可用依赖，避免启动恢复期间因晚注入而漏掉 Connector
MCP。`DefaultPreparer` 的最终输出以其 `PreparedRuntime.MCPServers` 为唯一事实，不能
在 Provider-specific prepare 之后丢弃或另建第二份结果字段。

### 7.2 ACP Provider

在 `session/new`、`session/load` 和需要的 resume 路径传入：

```json
{
  "mcpServers": [
    {
      "name": "connector",
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp/connector",
      "headers": [
        {
          "name": "Authorization",
          "value": "Bearer <session-token>"
        }
      ]
    }
  ]
}
```

创建 Connector Session Binding 前，必须先检查 initialize 响应中的
`agentCapabilities.mcpCapabilities.http == true`。只有明确声明支持的 Provider 才注入
Connector MCP、routing hints、Skill 和 Connector 提示；字段缺失、值为 false、能力探测
失败或 Connector 自身失败时，整体降级为不含 Connector 的普通 Session，不得阻断启动。

### 7.3 Codex

在 Session 隔离的 Codex 配置中注入：

```toml
[mcp_servers.connector]
url = "http://127.0.0.1:<port>/mcp/connector"
http_headers = { Authorization = "Bearer <session-token>" }
```

### 7.4 Claude SDK

在 Session 启动和恢复参数的 `mcpServers` 中注入相同 binding，不通过 Prompt
模拟工具可用性。

### 7.5 Tutti Agent

Tutti Agent 与 Codex 一样，在 Session 隔离配置中写入
`[mcp_servers.connector]`。所有 Provider 的投影都必须消费同一份
`PreparedRuntime.MCPServers`；不允许 Codex 正常、ACP/Claude/Tutti Agent 因各自
旁路而出现行为不一致。

### 7.6 动态列表刷新

已运行 Session 通过一个 `subscriptions/listen` SSE 连接订阅
`notifications/tools/list_changed`，收到 acknowledge 后才认为订阅建立。
Provider 兼容顺序为：

1. 标准 MCP list-changed 通知；
2. Provider 原生 MCP reload；
3. 下一轮开始前重新连接本地 `connector` Server；
4. Provider 确实不支持刷新时，才要求 resume 或重启 Session。

Provider 的兼容降级只能影响刷新时机，不能重新引入 `connector invoke`。

## 8. 会话安全与授权范围

本地 MCP Server 必须：

- 只监听 loopback；
- 校验 Host 和 Origin；
- 使用每个 Agent Session 独立的随机 bearer token；
- token 绑定 workspace ID 和 Agent Session ID；
- 相同 Session 重新签发时立即撤销旧 token；Session 清理、账户退出和 daemon 关闭时
  分别执行 `RevokeSession` 或 `RevokeAll`；
- 不在日志、Prompt、CLI 输出或 `connector available` 中泄露 token。

这里的 bearer token 是 daemon 签发的本地连接能力和生命周期隔离手段，不是
Connector 级权限模型。Server 向当前账户的 Agent Session 投影所有已发布且运行有效的
Connector route，不存在 `allowedKeys`、`selectedConnectorKeys` 或每连接器授权 Grant。
token 不依赖固定 TTL；失效由 Session、账户和 daemon 生命周期显式驱动，避免运行时间
超过固定时长后 MCP 无故消失。

## 9. 唯一公开命令：`connector available`

### 9.1 职责

`connector available` 只负责发现：

- 当前有哪些可用连接器；
- 连接器的名称和用途；
- 连接器提供哪些原生接口；
- MCP 工具使用哪个本地 Server 和命名前缀；
- CLI 应执行哪个稳定命令；
- 有哪些 Connector-owned Skills。

它不负责：

- 返回 MCP 工具 schema；
- 读取 Skill 内容；
- 执行 MCP 或 CLI；
- 注册 MCP Server；
- 返回本地端口、完整 URL、bearer token、headers、OAuth token；
- 返回上游 MCP endpoint 或内容寻址安装路径。

### 9.2 返回协议

建议扩展 `ConnectorSummary`：

```json
{
  "key": "github",
  "name": "GitHub",
  "description": "GitHub repository and issue operations",
  "skills": [
    {
      "name": "github-workflow",
      "title": "GitHub Workflow",
      "description": "Work with repositories, issues and pull requests"
    }
  ],
  "interfaces": [
    {
      "kind": "mcp",
      "serverName": "connector",
      "toolPrefix": "github_",
      "status": "ready"
    },
    {
      "kind": "cli",
      "command": "tutti-connector-github",
      "status": "ready"
    }
  ]
}
```

规则：

- 一个连接器可以同时声明 MCP、CLI 和 Skill。
- MCP 的完整动态工具 schema 只以 `tools/list` 为事实来源。
- CLI 只暴露稳定的连接器专属命令，不暴露实际 release 路径。
- Skill 摘要不暴露读取接口；Agent 通过已注入的原生 Skill root 解析内容。
- `status` 描述运行条件，不表示用户 enable/disable 状态。

### 9.3 为什么删除其他发现命令

`connector capabilities` 当前仅用于在调用 `connector invoke` 前取得 capability
ID 和 input schema。原生 MCP 使用 `tools/list`，CLI 使用真实命令，因此该命令
没有独立职责。

`connector skills` 返回的摘要已经包含在 `connector available` 中，Skill 内容
又由原生 Skill scanner/reader 管理，因此该命令是重复入口。

## 10. CLI 原生执行

每个包含 CLI interface 的连接器在 Tutti state 的 `bin` 目录发布稳定的专属
命令：

```text
tutti-connector-<connectorKey>
```

示例：

```bash
tutti-connector-github issue list --repo tutti-os/tutti
```

现有 Agent runtime 已把该 `bin` 目录加入 `PATH`。shim 负责：

- 固定指向当前已验证 release 的 CLI entrypoint；
- 随 route generation 原子发布，并只由相同 generation 内容移除；
- 设置连接器运行所需且允许暴露给子进程的环境；
- 原样转发 argv、stdin、stdout、stderr、信号和退出码。

Skill 和 `connector available.interfaces[].command` 只引用稳定命令，不引用
内容寻址 release 路径。

当前只接受 JSON stdin 的 typed command 不属于正常 CLI。对应连接器必须在切换前
完成以下一种迁移：

- 发布真正的 CLI entrypoint；或
- 在连接器专属 shim 中定义稳定、可文档化的子命令和参数映射。

不能用另一个全局 generic command 继续承载 capability ID 和 JSON input。

## 11. Skill 原生读取

延用现有 Connector routing hints 和 Tutti Agent extra Skill roots：

```text
active Connector route
  -> ConnectorRoutingHint.SkillRoot
  -> runtimeprep extra Skill roots
  -> Provider native Skill scanner
  -> Provider native Skill reader
```

需要更新 Connector policy 和运行时 Prompt：

- 删除 `connector skills`、`connector skill read`、`connector capabilities`、
  `connector invoke` 的指导；
- 对 MCP interface，指导 Agent 使用已注册的 `connector` MCP Server 工具；
- 对 CLI interface，指导 Agent 使用 `available` 中的稳定 CLI command；
- 保留“只能使用所选 Connector-owned Skill”的作用域约束；
- 不把 Skill 文件内容复制进 CLI JSON 响应。

连接器运行中移除后，MCP `tools/list` 是实时权威状态。已经被 Provider 读取进当前
上下文的 Skill 文本无法从历史上下文撤回，Agent 在实际调用前仍必须以当前 MCP
或 CLI route 可用性为准。

## 12. 命令下线

目标公开命令集：

```text
connector.available
```

从 CLI capability registry、Prompt policy、runtime capability allowlist、帮助文本、
测试 fixture 和架构文档中移除：

```text
connector.capabilities
connector.skills
connector.skill.read
connector.invoke
```

根本方案完成后不保留公开兼容别名。这四个命令应返回标准 command-not-found。
内部通用 CLI capability/invoke 执行链和 Connector Broker 的 `Capabilities`、
`Skills`、`ReadSkill`、`Invoke` 方法一并删除；诊断能力通过日志、指标、MCP
Registry debug snapshot 或内部 daemon 调试接口实现，不重新暴露为 Agent 公共命令。

## 13. 实施顺序

### 13.1 拆分 MCP 注册模型

涉及：

- `packages/connector/runtime/implementationhost/host.go`
- `packages/connector/runtime/implementationhost/mcp_routes.go`
- `packages/connector/runtime/implementationhost/broker.go`
- `packages/connector/runtime/route_table.go`

工作：

- 新增 `ConnectorMCPRegistry`；
- `registerMCPTools` 改为提交 MCP route；
- `RouteRegistry` 只保存 discover metadata，不再承载 MCP/CLI invoke；
- 保持现有 Reconcile 和 generation fencing；
- 为 Registry 增加 list-changed 订阅。

### 13.2 实现本地 MCP Server

在 `packages/connector/runtime/mcpserver` 中实现公共 Server；`tuttid` 的
`connectormcp` service 只保留类型别名和启动转发，并在 wiring 中负责实例生命周期。
实现现代无状态 HTTP discovery、工具列表、调用路由、订阅通知和 Session token；
不实现 Connector allowlist 或协议 Session。

### 13.3 注入 Agent Runtime

涉及：

- `packages/agent/runtimeprep/types.go`
- Agent host runtime preparation；
- `packages/agent/daemon/runtime/types.go`
- ACP、Codex app-server、Claude SDK 的 Session 创建和恢复路径。

工作：

- 新增并贯通 `MCPServerBinding`；
- 为每个 Agent Session 签发本地 connector token；
- 将 `connector` Server 注入所有支持 MCP 的 Provider；
- 实现各 Provider 的动态列表刷新兼容策略。

### 13.4 发布 CLI shim 和 Skill roots

- 为 CLI interface 创建、更新和清理稳定 shim；
- 确认 state `bin` PATH 在所有 Provider 中一致；
- 保持 Skill root 注入，并移除兼容读取路径；
- 更新连接器包的 Skill 内容，使其使用原生 MCP 和 CLI。

### 13.5 收敛发现协议和删除命令

- 扩展 `connector available` 的 `interfaces`；
- 删除四个公共 command capability 和 handler 分支；
- 删除 ImplementationHost 中失去调用方的通用 Broker 方法；
- 更新 Connector policy、运行时 Prompt、测试 helper 和文档；
- 更新 `docs/architecture/connector-market.md`，使其与新边界一致。

## 14. 切换策略

实现过程可以分阶段合入，但对 Agent 的最终公共行为必须一次切换：

1. 先构建 MCP Registry、Server、Agent 注入和 CLI shim，旧 Prompt 仍不切流。
2. 使用集成测试验证 native MCP、CLI 和 Skill 三条路径。
3. 更新 Prompt 和 policy，让 Agent 只走原生路径。
4. 同一版本删除四个公开命令及其 runtime allowlist。
5. 已存在的旧 Agent Session 通过 resume 或重启获得新的 MCP binding 和 Prompt。
6. 删除无调用方的内部 Broker 兼容实现。

切换期间不得把 native MCP 调用失败静默回退到 `connector invoke`，否则无法发现
Provider 注入或动态刷新问题。

## 15. 验证方案

### 15.1 Registry 单元测试

- managed stdio 和 remote MCP 都注册为 MCP route，而不是 command capability；
- add、remove、atomic swap 和 generation fence 正确；
- 工具前缀、排序、schema 和冲突校验正确；
- 失败的新 generation 不影响旧 route；
- 实际工具列表变化才触发 list-changed；
- 已 fence route 的调用返回标准 MCP 错误。

### 15.2 MCP Server 测试

- `server/discover -> tools/list -> tools/call` 完整链路；
- Provider 原生 `initialize -> tools/list -> tools/call` 完整链路；
- Provider 原生 `resources/list`、`resources/templates/list` 返回空列表；
- 每次请求的 `_meta` 和 MCP header 一致性校验；
- 本地工具名正确映射回上游原始名称和 arguments；
- 上游 content、structured result、`isError` 和 transport error 保持正确语义；
- invalid token 被拒绝，相同 Session 重签、Session 清理和 `RevokeAll` 立即使旧 token
  失效；
- 非 loopback Host、非法 Origin 被拒绝；
- HTTP `GET` / `DELETE` 和未声明的方法被拒绝；
- `subscriptions/listen` 先发送 acknowledged，Connector 更新后发送 list-changed，
  binding 撤销后结束订阅。

### 15.3 Provider 测试

- ACP `session/new` 和 `session/load` 收到非空 `mcpServers`；
- ACP 明确声明 HTTP MCP capability 时注入完整 Connector 上下文；
- ACP 未声明、声明 false 或能力探测失败时不绑定 Connector，普通 Session 正常启动；
- 未实现 Connector capability contract 的未来 Provider 默认按不支持降级；
- Codex Session 配置包含 `[mcp_servers.connector]`；
- Claude SDK Session options 包含 `connector` binding；
- Tutti Agent Session 配置包含 `[mcp_servers.connector]`；
- DefaultPreparer 的最终返回保留 authoritative `MCPServers`；
- Connector 在 Agent 已运行后接入，工具无需新建 Session 即可出现；
- Provider 不支持标准通知时按定义的兼容层刷新。

### 15.4 CLI 和 Skill 测试

- shim 正确透传 argv、stdio、信号和退出码；
- release 更新后稳定命令自动指向新 generation；
- 卸载或鉴权失效后 shim 不执行过期 release；
- Connector Skill 能被各 Provider 原生 scanner 发现和读取；
- Prompt 不再引用四个已删除命令。

### 15.5 公共边界测试

- Connector Broker 只注册 `connector.available`；
- `available.interfaces` 正确描述 MCP 和 CLI；
- `available` 不返回 URL、端口、token、headers、OAuth 信息或 release 路径；
- 四个旧命令返回 command-not-found；
- 用户自定义 MCP 不出现在 `connector` Server 的 `tools/list` 中。

建议按改动范围运行：

```bash
go test ./packages/connector/runtime/...
go test ./packages/agent/runtimeprep/...
go test ./packages/agent/daemon/runtime/...
go test ./services/tuttid/service/connectormarket/...
go test ./services/tuttid/service/agent/...
go test ./services/tuttid/...
```

并运行仓库已有的 lint、类型检查以及 Connector managed stdio/remote MCP
集成复现命令。

## 16. 风险和约束

### 16.1 Provider 动态刷新差异

不同 Provider 对 `notifications/tools/list_changed` 的支持可能不一致。必须分别
验证，降级到 Provider reload 或下一轮重连，但不能降级回私有 invoke。

### 16.2 工具名限制

增加 connector key 前缀后可能超过 Provider 限制。注册阶段应确定统一的最大长度
和 canonicalization 规则，不能在不同 Provider adapter 中分别截断。

### 16.3 在途调用与更新

route 更新必须依赖 immutable binding 和 generation fence。不能关闭旧 client 后
再决定调用属于哪个 generation。

### 16.4 CLI 合约迁移

JSON stdin typed commands 不能自动视为正常 CLI。每个受影响连接器都必须有明确的
命令行合约和 Skill 示例后才能删除旧 invoke 路径。

### 16.5 已物化 Skill 内容

Provider 已经读取到当前上下文的 Skill 无法被动态撤回。运行时 MCP/CLI route 和
当前账户的 Connector 发布状态必须作为最终可用性边界，不能仅依赖 Prompt。本地
Session token 只隔离连接和生命周期，不承担 Connector 级权限。

### 16.6 旧文档和测试形成错误事实

现有 `connector-market.md`、Connector policy 和测试明确宣称五个公开命令。实现
完成时必须同步修改，否则后续维护会重新引入已下线的私有调用模型。

## 17. 完成定义

满足以下条件后方案才算完成：

- Agent 通过本地 `connector` MCP Server 原生发现并调用所有 Connector MCP；
- Connector MCP 支持不重启 daemon 的动态注册、更新和移除；
- Agent Session 可以感知工具列表变化；
- CLI 只通过连接器专属命令正常执行；
- Skill 只通过 Agent 原生机制发现和读取；
- 用户自定义 MCP 与 Connector MCP 隔离；
- 公共命令只剩 `tutti connector available`；
- 首期没有新增 enable/disable 状态或入口；
- 安全、生命周期、Provider 和端到端测试全部通过；
- 架构文档、Prompt、policy、CLI help 和实现保持一致。
