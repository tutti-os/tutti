# Tutti Agent 集成方案设计（tutti-agent Integration Plan）

Status: implementation in progress

Last reviewed: 2026-07-03

本文档设计将第一方 agent provider `tutti-agent` 集成进现有 Tutti 本地优先 agent 栈的方案。所有结论基于当前代码核实，依据来源：

- 本仓库 daemon/runtime/desktop/AgentGUI 代码（具体路径见各节）
- AgentGUI 架构文档：`docs/architecture/agent-gui-node.md`、`docs/architecture/agent-activity-packages.md`、`packages/agent/gui/AGENTS.md`（注：需求中提到的 `docs/agent-gui` 目录在当前仓库不存在，代码在 `packages/agent/gui/`）
- 外部 fork 仓库 `~/work/tutti-os/tutti-agent`
- 模型网关鉴权指南 `~/work/tutti-lab/tsh-llm-provider/docs/host-llm-token-integration.zh-CN.md`

## 1. 概述与结论

`tutti-agent` 是 Codex CLI/SDK 仓库的品牌化 fork，通过与 Codex 相同的 `app-server` JSON-RPC（Thread/Turn/Item 生命周期）接入。它必须建模为**独立 provider**，而不是 Codex 的别名或换皮：它有独立的 npm 包、二进制、home 目录、鉴权存储、品牌标识和 token 生命周期。

核心标识约定：

| 项                 | 值                            |
| ------------------ | ----------------------------- |
| provider id        | `tutti-agent`                 |
| npm 包             | `@tutti-os/tutti-agent@0.0.1` |
| 二进制             | `tutti-agent`                 |
| app-server 命令    | `tutti-agent app-server`      |
| home 环境变量      | `TUTTI_AGENT_HOME`            |
| 默认 home          | `~/.tutti-agent`              |
| 本地系统 target id | `local:tutti-agent`           |
| 工作区应用 id      | `agent-tutti-agent`           |
| 展示名             | `Tutti Agent`                 |

推荐路径（详见后文）：

1. 将现有 Codex app-server 适配器**参数化**为一个可配置的 app-server 适配器家族（参照 ACP 侧已有的 `standardACPConfig` 范式），Codex 与 tutti-agent 共享 reducer/projection/turn 机制，但隔离命令、home、client identity、鉴权文案。
2. 新增 `TuttiAgentPreparer` 负责 `TUTTI_AGENT_HOME` 与 daemon 侧 LLM token bootstrap（`tutti-agent login --with-tutti-llm-tokens`）。
3. UI 新入口统一受渲染进程设置开关 `tutti.workspaceSettings.tuttiAgentSwitchEnabled` 控制：**开关只挡新入口，不隐藏历史会话**。
4. `defaultAgentProvider` 契约需要单独决策：当前 OpenAPI 复用 `WorkspaceAgentProvider` 枚举，加 provider 会连带让它成为合法默认值，建议拆分枚举。
5. 历史/runtime 层保留 legacy provider identity 兼容旧数据；桌面新入口层下线旧的 legacy "Tutti" 入口，改由 `agent-tutti-agent` / `local:tutti-agent` 承担。

## 2. 现状架构

### 2.1 所有权边界

现有边界保持不变：

- `services/tuttid`：provider 归一化、持久 target、可用性/安装/鉴权状态、会话创建规则、runtime 准备（sidecar preparer）、模型目录与 composer 选项、HTTP 契约、工作区数据库迁移。
- `packages/agent/daemon/runtime`：provider runtime 适配器，把各 provider 的 wire 协议翻译成共享的 activity 事件模型。
- `apps/desktop`：Electron/preload/renderer 集成、tuttid 客户端调用、workbench 外壳、provider 状态服务、资产 URL、本地设置 UI。
- `packages/agent/gui`：宿主无关的 AgentGUI（provider target 选择、workbench contribution、会话 rail、composer、审批、时间线渲染）。

AgentGUI 不允许感知 provider wire 协议；provider 事件必须经 `packages/agent/daemon/runtime` 和 Agent Activity projection 流入。

### 2.2 Provider 家族

| 家族               | Provider                                      | 协议/运行形态                                                                                                                            | 关键约束                                                                                                                                                                 |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex app-server   | `codex`                                       | spawn `codex app-server` → JSON-RPC `initialize` / `thread/start` / `turn/start` / 通知 / server request → reducer → activity projection | 非 ACP（codex-over-ACP 已退役，见 `docs/specs/2026-07-01-codex-appserver-refactor-design.md` 决策 D1）。当前实现**硬编码**命令、provider、originator、鉴权文案（见 2.5） |
| Tutti app-server   | 拟新增 `tutti-agent`                          | 同上生命周期，但命令 `tutti-agent app-server`、`TUTTI_AGENT_HOME`、initialize 返回 `tuttiAgentHome`、`tutti_llm` 鉴权                    | 共享 app-server 机制，但不得复用 Codex 官方 client identity 与 home/auth 假设                                                                                            |
| Claude SDK sidecar | `claude-code` 默认路径                        | Claude sidecar 行协议                                                                                                                    | 非 ACP                                                                                                                                                                   |
| 标准 ACP           | `hermes`、`openclaw`、legacy provider（部分） | `standardACPAdapter` + 每 provider 一份 `standardACPConfig`                                                                              | 已参数化，是本方案 adapter 参数化的范式参照                                                                                                                              |

关键结论：`tutti-agent` 走 Codex-app-server 兼容路径，**不能**接入标准 ACP 适配器，也不能描述为"只换二进制"。

### 2.3 Agent Activity 数据流（唯一受支持的 UI 流）

```text
Runtime adapter
  -> activityshared.Event
  -> runtime reporter
  -> message_update / state_patch projection
  -> tuttid agent session/activity API 与 SSE
  -> desktop AgentActivityAdapter
  -> WorkspaceAgentActivityService
  -> AgentActivityRuntime
  -> AgentGUI / AgentGuiNode controller
  -> transcript、composer、approvals、prompts、rail
```

### 2.4 Provider Target 数据流（target-first 启动）

```text
agent_targets 表（seed 于 agent_targets_migrations.go）
  -> /v1/agent-targets
  -> apps/desktop workspaceAgentGuiProviderTargets.ts
     mapAgentTargetsToAgentGuiProviderTargets()
  -> AgentGUIProviderTarget[]
  -> useWorkspaceWorkbenchShellRuntime.tsx（resolvedAgentGuiProviderTargets）
  -> workspaceWorkbenchContributionFactory.ts
  -> createWorkspaceAgentGuiContribution / DesktopAgentGUIWorkbenchBody
  -> AgentGUI / useAgentGUINodeController
  -> createSession({ agentTargetId })
  -> tuttid 解析 target 得到 provider + providerTargetRef
```

daemon 会拒绝请求 provider 与存储 target 推导 provider 不一致的情况。所以 UI 应传 `agentTargetId: "local:tutti-agent"`，不自行合成 provider 真值。

当前阻塞点：`services/tuttid/biz/agenttarget/model.go` 的 `normalizeFirstIterationProvider` 只接受 `codex`/`claude-code`。只加 seed 不够，归一化与持久层读取都必须接受 `tutti-agent`，否则 target 列表会丢掉它。

### 2.5 Codex app-server 适配器的硬编码现状（核实结论）

`packages/agent/daemon/runtime/` 下的 codex app-server 实现（`codex_appserver_adapter.go`（约 93KB）、`codex_appserver_client.go`、`codex_appserver_events.go`、`codex_appserver_reducer.go`、`codex_appserver_turn_machine.go` 等）**没有任何配置结构**，以下均为包级硬编码：

- 命令：`codexAppServerCommand = "codex"`、`codexAppServerSubcmd = "app-server"`（`codex_appserver_adapter.go:24-25`），用于 `ProcessSpec.Command`、`commandString()`、`resolveCodexCLIVersion`（跑 `codex --version`）。
- provider：`Provider()` 固定返回 `ProviderCodex`；`ProcessSpec.Provider = ProviderCodex`。
- client identity：`codexOfficialOriginator = "codex_cli_rs"`（约 line 228）。`clientInfo.name` 会原样成为出站 originator/User-Agent，用于通过上游"官方 Codex 客户端"allowlist——**fork 绝不能复用这个值**。
- 鉴权文案：`codexAppServerAuthRequiredMessage`（约 line 92，提示用户跑 `codex login`）。
- initialize 结果解析：`codex_appserver_events.go:1752` `appServerInfo()` 读取 `codexHome` 字段。
- 注意：`CODEX_HOME` **不在 adapter 里注入**，来自 sidecar 的 `CodexPreparer`（见 2.6），经 `session.Env` 传入。adapter 侧 `provider_endpoint.go:133` 会读 env 中的 `CODEX_HOME`（缺省 `~/.codex`）。

适配器注册：`controller.go` 的 `NewDefaultControllerWithOptions` 构建 adapter slice（`newDefaultClaudeCodeAdapter`、`NewCodexAppServerAdapterWithHostMetadata`、以及四个 ACP adapter），controller 按 `Adapter.Provider()` 建索引分发。新增 adapter 只需要加进这个 slice。

对比范式：`standard_acp_adapter.go` 的 `standardACPConfig`（字段含 `provider`、`adapterName`、`command`、`commandResolver`、`env`、`initializeParams`、`authRequiredMessage`、`permissionModeID` 等），一个 adapter 类型被 legacy ACP adapter / `NewGeminiAdapter…` / `NewHermesAdapter…` / `NewOpenClawAdapter…` 用不同配置实例化。app-server 侧目前没有对应物——这正是本方案的核心改造。

### 2.6 Runtime 准备（sidecar preparer）

`services/tuttid/service/agentsidecar/preparer.go` 的 `NewDefaultPreparer` 注册 `CodexPreparer`（`codex.go`）、`ClaudeCodePreparer`、`GeminiPreparer` 及三个 `InstructionFilePreparer`，接口为 `ProviderPreparer`（`Provider() string` + `Prepare(...) (ProviderPrepareResult{Cwd, Env}, error)`）。

`CodexPreparer` 做的事（tutti-agent preparer 的模板）：

- 创建会话级 `<RuntimeRoot>/codex-home`（0700），返回 `Env: ["CODEX_HOME=..."]`——**这是 CODEX_HOME 的唯一来源**。
- 向 `<codexHome>/AGENTS.md` 写 managed block 指令。
- `exposeUserCodexFiles`：symlink/copy `~/.codex` 的 `auth.json`、plugin cache、`config.toml`。
- `ensureCodexSessionConfig`：改写 `config.toml`（project_root_markers、service_tier、`[tutti]` 段、developer_instructions）。
- skills 暴露与 provider 原生 skills 安装、审批 rules 写入。

共享 env（`defaultRuntimeEnv`）：`TUTTI_WORKSPACE_ID`、`TUTTI_AGENT_SESSION_ID`、`TUTTI_AGENT_PROVIDER`、`TUTTI_AGENT_CWD`、PATH 等。

### 2.7 Provider 状态/安装/鉴权

`services/tuttid/service/agentstatus/registry.go` 的 `ProviderSpec`：`BinaryNames`、`AdapterBinaryNames`、`AdapterCommand`、`AuthStatusCommand`、`AuthMarkerPaths`、`Install`、`LoginArgs` 等。Codex spec：

```text
BinaryNames:        ["codex"]
AdapterCommand:     ["codex", "app-server"]
AuthStatusCommand:  ["login", "-c", `service_tier="fast"`, "status"]
AuthMarkerPaths:    ["~/.codex/auth.json"]
Install:            InstallerKindCodexCLILatest（npm @openai/codex + optional-dep 平台二进制）
```

鉴权输出解析在 `service_helpers.go` 按 provider switch：`parseCodexAuthStatusOutput`（文本匹配 "logged in"/"not logged in"）、`parseClaudeAuthStatusOutput`（JSON）。**没有解析分支的 provider 会退化为"marker 文件存在即已鉴权"**——tutti-agent 必须有自己的解析分支或 bootstrap 校验，避免误报。

### 2.8 模型目录与 composer 选项

- `services/tuttid/service/agent/codex_model_catalog.go`：`CodexCLIModelLister.ListModels` 真实 spawn `codex app-server` → `initialize`（clientInfo `{name:"tuttid", version:"0.1.0"}`）→ `model/list`（limit 200）→ 归一化。
- `model_catalog.go`：`CachedAgentModelCatalog` 按 provider switch 缓存（codex TTL 30s / error 5s），目前 codex、tutti-agent、opencode 有 lister。
- `composer_options.go`：大量 provider switch；composer 设置支持目前直接编码在 provider 分支里（claude-code/codex/tutti-agent/opencode）。**注意约 line 662、777 存在裸字符串 `provider == "codex"` 比较**，参数化时需一并梳理。

### 2.9 契约与偏好模型

- OpenAPI `services/tuttid/api/openapi/tuttid.v1.yaml`：
  - `WorkspaceAgentProvider`（约 line 5416）：provider 枚举，被 `DesktopPreferences.defaultAgentProvider`（约 line 4021）直接 `$ref` 复用——**加 provider 会连带让它成为合法默认值**。
  - `AgentTargetProvider`（约 line 4149）：只有 `codex`/`claude-code`。
  - `DesktopAgentComposerDefaultsByProvider` / `DesktopAgentGuiConversationRailCollapsedByProvider`：**逐 provider 显式属性 + `additionalProperties: false`** 的闭合结构，新 provider 必须显式加属性。
- Event protocol：`packages/events/protocol/schemas/topics/preferences/desktop-preferences.schema.json` 与 OpenAPI 同构（闭合、枚举显式列出 provider），生成物在 `src/generated/`。
- Codegen：`pnpm generate:api` / `check:api-generated`、`pnpm generate:event-protocol` / `check:event-protocol-generated`、`pnpm check:codexproto-generated`；`build:go`/`test:go`/`lint:go` 前置 `generate:builtin-apps`。

### 2.10 UI 开关现状

```text
localStorage key: tutti.workspaceSettings.tuttiAgentSwitchEnabled（"1"/"0"）
读写:   apps/desktop/.../workspace-workbench/services/tuttiAgentSwitchPreference.ts
服务:   workspaceSettingsService.ts  setTuttiAgentSwitchEnabled()
store:  workspaceSettingsStore.ts:32 种子读取
```

**当前唯一消费者是 `WorkspaceSettingsPanel.tsx`**：控制设置面板 "account" 分区显隐，以及 Developer 面板里的开关本体（i18n key `workspace.settings.developer.tuttiAgentSwitchLabel/Description`，en/zh-CN 已存在）。它尚未接入 workbench contribution、provider target、dock、launchpad 或 AgentGUI——provider 入口接开关是全新接线。

### 2.11 UI 侧 provider 元数据现状

- **三个需同步扩的 provider 枚举**：
  - `packages/agent/gui/contexts/settings/domain/agentSettings.providers.ts` 的 `AGENT_PROVIDERS` / `AgentProvider`
  - `packages/agent/gui/types.ts:67` 的 `AgentGUIProvider`
  - `packages/agent/gui/workbench/types.ts:3` 的 `AgentGuiWorkbenchProvider`
- `packages/agent/gui/workbench/providerCatalog.ts`：`agentGuiWorkbenchDefaultDockProviders = ["codex","claude-code","tutti-agent"]`、`dockSuppressedProviders = ["hermes","opencode"]`、`comingSoonProviders` 为空、brand label Record（带 `// i18n-check-ignore` 注释）。desktop 侧经 `workspaceAgentProviderCatalog.ts` shim 转 re-export。
- `packages/agent/gui/providerTargets.ts`：`localAgentGUIAgentTargetId(provider)` 只认 codex/claude-code。
- Dock 可见性：`workspaceAgentProviderDockStateSource.ts` 的 `shouldShowAgentProviderInDock(provider, status)` = 非 suppressed 且（defaultDock 或 `status === "ready"`）；`workspaceAgentGuiContribution.ts:243` 的 `resolveDockEntryVisibility`。
- Launchpad：`WorkspaceLaunchpadOverlay.tsx` 遍历 `workspaceAgentGuiProviders`；旧 legacy "Tutti" 特判已下线，新入口统一使用 `tutti-agent` / "Tutti Agent"。
- 图标三处注册表：
  1. `packages/agent/gui/managedAgentIconAssets.ts` + `packages/agent/gui/app/renderer/assets/icons/agents/*.png`（供 `dockIcons.ts` 的 `agentGuiDockIconUrls` 与 `shared/managedAgentIcons.ts`）；
  2. `apps/desktop/.../workspace-workbench/services/workspaceDockIconStyle.ts` 的 `agents: Record<AgentGuiWorkbenchProvider, string>`（枚举扩了会编译报错强制补齐，是安全网）；
  3. `apps/desktop/src/shared/tuttiAssetProtocol.ts`（`tutti-asset://` 协议）+ `apps/desktop/src/shared/workspaceAppIconDefaults.ts`（`SEEDED_DESKTOP_WORKSPACE_APP_ICON_IDS` 现含 `agent-codex`/`agent-claude-code`）。
- `agent-<provider>` 工作区应用 id 三处映射：`workspaceAppIconDefaults.ts`、`rich-text-at/providers/desktopWorkspaceAppMentionOrdering.ts`、`rich-text-at/services/internal/desktopRichTextAtService.ts`（app-id↔provider 映射与特判）。
- 历史会话：rail 按会话自身 provider 渲染，**不做 provider 枚举过滤**（`resolveWorkspaceAgentGuiDockPopupTitle` 对缺失 provider 才 fallback "codex"）——支撑"关开关不藏历史"的语义。

## 3. 外部依据

### 3.1 fork 仓库事实（~/work/tutti-os/tutti-agent，已核实）

- `codex-cli/package.json`：name `@tutti-os/tutti-agent`，bin `tutti-agent`（仓库内 0.0.0-dev，发布版 0.0.1）。
- app-server 及协议 crate 保留 Thread/Turn/Item 生命周期；`model/list` RPC 存在（`codex-rs/app-server-protocol/src/protocol/common.rs:858`）。
- initialize 响应 home 字段为 `tuttiAgentHome`，带 serde alias `codexHome`（`codex-rs/app-server-protocol/src/protocol/v1.rs:67-68`）。**alias 只作用于反序列化，序列化输出是 `tuttiAgentHome`**——Tutti 现有 adapter 读 `codexHome` 会拿不到值，必须适配。
- home 逻辑使用 `TUTTI_AGENT_HOME`（config/core 广泛引用）；项目配置目录 `.tutti-agent`，legacy `.codex` 仅作兼容 fallback。
- `tutti-agent login --with-tutti-llm-tokens` 与 `tutti_llm` 鉴权存储存在（`codex-rs/cli/src/login.rs`、`codex-rs/login/`）。

### 3.2 模型网关 token 链路（zh-CN 指南，已核实）

```text
宿主登录态 cookie session_id
  -> POST https://tutti.sh/api/account/auth/v1/llm-token
       requested_app_id: legacy account app id (`nex` + `top`)
       scopes: ["llm:models", "llm:chat"]
  -> 返回 lat_（access）/ lrt_（refresh）bundle
  -> 转成 stdin JSON 喂给 `tutti-agent login --with-tutti-llm-tokens`
  -> TUTTI_AGENT_HOME/auth.json 写入 tutti_llm 段
  -> 模型调用自动带 Authorization: Bearer lat_xxx
  -> SDK 自动 refresh（POST .../llm-token/refresh）
  -> 登出：daemon 调 revoke 并清理 auth.json
```

关键约束：

- refresh token 会 rotate，旧 token 重放会导致**整个 token family 被撤销**——多个并发 agent home 共享同一 refresh family 是危险的，token 处理需要单一属主或串行化。
- 当前线上策略（AppConfig LLM access policy）：Tutti desktop app id 仅允许 `gpt-5.4`、协议 `openai_responses`、provider `openrouter`；其他模型返回 403。**因此模型列表必须来自 app-server `model/list` 实时结果，不能做静态兜底列表**。
- 安全边界：`session_id` 不进模型网关、不进 `auth.json`、不进环境变量/AgentGUI 状态/activity 快照/日志；渲染进程永不持有 LLM refresh token。

## 4. 目标设计

### 4.1 Provider 标识与 target

新增规范 provider 常量 `tutti-agent`：

- `services/tuttid/biz/agentprovider/provider.go`：加常量、进 `All()`、`Normalize` 加 case。**不得动现有 `"tutti"` 别名**（它归一化到 legacy provider，改动会静默改变既有行为）。
- `packages/agent/daemon/runtime/types.go`：加 `ProviderTuttiAgent`。
- OpenAPI：`WorkspaceAgentProvider` 与 `AgentTargetProvider` 扩枚举（配合 4.6 的拆分决策）。
- UI 三枚举 + Record 映射（见 2.11）。

新增系统 target：

```text
id:              local:tutti-agent
provider:        tutti-agent
launch_ref_json: {"type":"local_cli","provider":"tutti-agent"}
name:            Tutti Agent
icon_key:        tutti-agent
enabled:         true
source:          system
```

需同步的层：`agenttarget` 常量与 `normalizeFirstIterationProvider`（更名或扩语义）、`DefaultSystemTargets` seed、`agent_targets_migrations.go`、`sqlite_agent_targets.go` 读取、生成的 `AgentTargetProvider`、desktop `mapAgentTargetsToAgentGuiProviderTargets`、AgentGUI `localAgentGUIAgentTargetId("tutti-agent")`。

### 4.2 Runtime adapter 参数化（核心改造）

将 codex app-server 实现重构为"配置驱动的 app-server 适配器家族"，参照 `standardACPConfig` 范式：

```go
type AppServerAdapterConfig struct {
    Provider            runtime.Provider // codex | tutti-agent
    DisplayName         string
    Command             []string         // ["codex","app-server"] / ["tutti-agent","app-server"]
    HomeEnvName         string           // CODEX_HOME / TUTTI_AGENT_HOME
    InitializeHomeField string           // "codexHome" / "tuttiAgentHome"
    ClientInfo          AppServerClientInfoResolver
    AuthRequiredMessage string
    // 能力开关：权限模式映射、collaboration mode、rate-limit、account 读取等
}
```

暴露两个构造器：

```go
NewCodexAppServerAdapterWithHostMetadata(...)      // 行为与现状完全一致
NewTuttiAgentAppServerAdapterWithHostMetadata(...) // 新配置
```

Codex 保持现有官方行为：`codex app-server`、`CODEX_HOME`、`codexHome`、Codex 鉴权文案、`codex --version` 解析、`codex_cli_rs` originator。

Tutti Agent 使用：`tutti-agent app-server`、`TUTTI_AGENT_HOME`、`tuttiAgentHome`、Tutti 鉴权文案、**Tutti 自己的 client identity（严禁复用 `codex_cli_rs`）**，且 provider id `tutti-agent` 必须贯穿 process spec、session 状态、activity projection、子线程归属、错误上报。

reducer/projection/turn machine 在 fork 保持 app-server schema 兼容的前提下共享。若 fork 将来扩展 schema，走独立的 schema/codegen 策略（`codexproto` 有 `check:codexproto-generated` 约束），不得静默改 Codex 生成协议文件。

`appServerInfo()`（`codex_appserver_events.go`）按 `InitializeHomeField` 读 home 字段；也可同时兼容读取两个字段名做防御。

### 4.3 TuttiAgentPreparer 与 daemon 侧 token bootstrap

新增 `services/tuttid/service/agentsidecar/tutti_agent.go`（注册进 `NewDefaultPreparer`），职责对照 `CodexPreparer`：

- 创建会话级 runtime home，注入 `TUTTI_AGENT_HOME`。
- **不**以 `~/.codex` 为主状态来源（fork 的 legacy 兼容只是 fallback，不应被 Tutti 依赖）；按契约从 `~/.tutti-agent` 暴露安全配置。
- 用现有 daemon 侧机制渲染 workspace instructions（AGENTS.md managed block）与 skills。
- 注入与其他 provider 一致的 `TUTTI_*` 会话 env。
- 启动前调用 daemon 持有的鉴权 bootstrap。

鉴权 bootstrap 必须在 daemon 侧（严禁放进渲染进程、AgentGUI、workbench contribution 或 target 映射）：

```text
tuttid 获取宿主登录态（account/session 集成点，见开放问题）
  -> POST /api/account/auth/v1/llm-token（requested_app_id 为 legacy account app id）
  -> stdin JSON -> spawn `tutti-agent login --with-tutti-llm-tokens`
  -> 校验 TUTTI_AGENT_HOME/auth.json 的 tutti_llm 可用
  -> 启动 app-server
```

登出/清理：宿主登出时由 daemon 先清 auth marker，再用已读取的 refresh token best-effort 调 revoke。

### 4.4 Provider 状态/安装/鉴权 spec

在 `services/tuttid/service/agentstatus/registry.go` 增加 spec：

- `BinaryNames` / `AdapterBinaryNames`: `["tutti-agent"]`
- `AdapterCommand`: `["tutti-agent", "app-server"]`
- `Install`: `npm install -g @tutti-os/tutti-agent@0.0.1`（若沿用 Codex 的 npm+optional-dep 平台二进制安装器，需要确认 fork 的发布产物形态后决定 InstallerKind）
- `AuthMarkerPaths`: `~/.tutti-agent/auth.json`
- 鉴权判定：**必须**在 `service_helpers.go` 加 tutti-agent 的解析分支（解析 `tutti_llm` 段或跑 `tutti-agent login status`），不能落入"marker 文件存在即已鉴权"的默认路径。
- probe：廉价的 `--version` 或 app-server initialize 检查；状态标签沿用 `ready` / `not_installed` / `auth_required` / `unsupported` / `unknown`。

命令解析注意：codex 的 runtime adapter 目前硬编码命令而非走 status registry 的 resolver；tutti-agent 通过 4.2 的 `Command` 配置显式给出，或统一接 resolver。

### 4.5 模型目录与 composer

把 `CodexCLIModelLister` 泛化为 app-server model lister：

```text
codex:       command ["codex","app-server"]        source "codex-cli"
tutti-agent: command ["tutti-agent","app-server"]  source "tutti-agent-cli"
```

- `model_catalog.go` 的 `CachedAgentModelCatalog` 加 tutti-agent lister 与缓存分支。
- **不设静态兜底模型列表**：网关策略当前只放行 `gpt-5.4`，composer 选项必须反映 `model/list` 实时鉴权结果。
- `composer_options.go` 各 provider switch 需要加入 `tutti-agent` 决策（含 line 662/777 的裸 `provider == "codex"` 比较）：reasoning effort、plan/permission mode、speed/service-tier 是否对 fork 生效——建议 Phase 0 冒烟后按 fork 实际能力定。

### 4.6 契约决策：defaultAgentProvider 枚举拆分

`DesktopPreferences.defaultAgentProvider` 目前 `$ref` `WorkspaceAgentProvider`。把 `tutti-agent` 加进后者，它就自动成为合法默认 provider。两条路：

1. **拆分枚举（推荐）**：`WorkspaceAgentProvider` 扩容供 runtime/session/status 使用；新增更窄的 `DesktopDefaultAgentProvider` 供 `defaultAgentProvider` 使用，`tutti-agent` 暂不进默认候选，直到产品明确。
2. 推迟类型化暴露：只做内部 spike，不进公共契约——不满足本次生产级诉求，排除。

provider-keyed 偏好（`agentComposerDefaultsByProvider`、`agentGuiConversationRailCollapsedByProvider`）是闭合结构（`additionalProperties: false`），OpenAPI 与 event-protocol schema 双侧都要显式加 `tutti-agent` 属性（或带测试地明确跳过持久化），否则新键会被 schema 拒绝。改完跑：

```sh
pnpm generate:api && pnpm check:api-generated
pnpm generate:event-protocol && pnpm check:event-protocol-generated
```

### 4.7 UI 开关语义（tutti-agent-switch）

判定条件统一为 `workspaceSettingsService` store 的 `tuttiAgentSwitchEnabled === true`。

**注入点**：`useWorkspaceWorkbenchShellRuntime.tsx` 已同时持有 `workspaceSettingsService`（line 126）和 `resolvedAgentGuiProviderTargets`（line 133），在 target/provider 列表进入 contribution、dock、launchpad 之前按开关过滤 `tutti-agent`，是改动面最小、语义最集中的方案。现有 providerCatalog 的静态集合（comingSoon/dockSuppressed/defaultDock）不适合表达动态开关，不复用。

开关**关闭**时隐藏的新入口：

- unified dock 与 legacy split dock 的 tutti-agent 入口及默认 target 解析
- provider rail target、composer provider 选择项、新会话 target 网格
- `WorkspaceLaunchpadOverlay` 的 provider 项
- dock 状态/动作展示
- 工作区应用/mention 入口 `agent-tutti-agent`
- （后续若允许）settings 默认 provider 选项

开关关闭时**不隐藏**的历史/读路径：

- 全部会话列表中的既有 tutti-agent 会话、按 session id 直接打开、已打开的 workbench 节点、transcript 渲染、活动会话的追问 UI（受 runtime 可用性约束）、activity 快照与会话记录。

理由：会话历史投影自 runtime/session 快照，rail 本就按会话自身 provider 渲染（2.11）。全局按 provider 枚举过滤会让既有会话"看起来被删除"。**开关是产品入口闸门，不是数据保留或协议真值来源。** 实现上传入"过滤后的 target 列表 + 入口元数据"，不要全局过滤 provider 枚举。

### 4.8 图标、品牌与 i18n

- 新增 `tutti-agent-rounded.png` 等资产，三处注册表都要加（2.11 清单）；`Record<Provider, string>` 类型会以编译错误兜底。
- `agent-tutti-agent` 加进 `workspaceAppIconDefaults.ts`、`desktopWorkspaceAppMentionOrdering.ts`、`desktopRichTextAtService.ts` 的映射，mention 入口同样受开关闸门。
- 文案走 i18n（en/zh-CN 双写，`pnpm check:i18n`）；代码内品牌名字面量按现有惯例加 `// i18n-check-ignore` 注释。
- **Legacy/Tutti 命名决策**：旧 legacy provider 只保留历史/runtime identity，不再作为桌面新入口；新建会话、dock、launchpad、mention 和 composer/rail 入口统一走 `tutti-agent` / "Tutti Agent"。

## 5. 端到端数据流

### 5.1 开关开启，新建会话

```text
设置面板 -> setTuttiAgentSwitchEnabled(true)
  -> localStorage tutti.workspaceSettings.tuttiAgentSwitchEnabled = "1"
  -> useWorkspaceWorkbenchShellRuntime 读到开关，target 列表保留 local:tutti-agent
  -> dock / launchpad / provider rail / composer 出现 Tutti Agent
  -> createSession({ agentTargetId: "local:tutti-agent" })
  -> tuttid 解析 target -> provider "tutti-agent"，校验可用性与模型
  -> TuttiAgentPreparer 建 TUTTI_AGENT_HOME，daemon bootstrap tutti_llm
  -> RuntimeController.Start(provider "tutti-agent")
  -> app-server adapter（tutti-agent 配置）spawn `tutti-agent app-server`
  -> initialize（读 tuttiAgentHome）/ thread/start / turn/start
  -> 通知 -> reducer -> activityshared.Event -> projection
  -> AgentGUI transcript / tools / approvals / prompts
```

### 5.2 开关关闭，历史会话

```text
tuttiAgentSwitchEnabled = false
  -> 新建入口全部隐藏
  -> /v1/agent-sessions 与 activity 快照仍含既有会话
  -> 按 session id 打开可见 transcript
  -> 追问/发送取决于 provider 状态与 runtime 支持
```

### 5.3 状态流

```text
agentprovider.All() -> agentstatus DefaultRegistry -> 安装/鉴权/probe
  -> /v1/agent-providers/status -> desktop AgentProviderStatusService
  -> dock readiness / launchpad 可用性 / DesktopAgentGUIWorkbenchBody chat-ready 探测
  -> 开关关闭时入口被闸门抑制（状态数据本身不受影响）
```

### 5.4 模型流

```text
composer 选项请求（provider "tutti-agent"）
  -> CachedAgentModelCatalog -> AppServerModelLister
  -> spawn tutti-agent app-server -> initialize -> model/list
  -> 只返回当前网关授权模型（现策略即 gpt-5.4）
  -> composer 模型菜单与创建/执行校验
```

### 5.5 鉴权流

```text
daemon 获取宿主登录态 -> account llm-token 签发（legacy account app id）
  -> stdin -> tutti-agent login --with-tutti-llm-tokens
  -> TUTTI_AGENT_HOME/auth.json（tutti_llm）
  -> app-server 以 lat_ 调网关，SDK 自动 refresh（rotate）
  -> 登出 -> daemon revoke -> family 失效
```

## 6. 实施工作包

### WP1 Provider 与 target 域

- `services/tuttid/biz/agentprovider/provider.go`：常量、`All`、`Normalize`（保留 `tutti`→legacy provider）。
- `services/tuttid/biz/agenttarget/model.go`：`IDLocalTuttiAgent`、`DefaultSystemTargets`、`normalizeFirstIterationProvider` 扩展。
- `services/tuttid/data/workspace/agent_targets_migrations.go` / `sqlite_agent_targets.go`：seed 与读取。
- 相关归一化/seed/列表测试。

### WP2 契约、事件、客户端、偏好

- `services/tuttid/api/openapi/tuttid.v1.yaml`：`WorkspaceAgentProvider`、`AgentTargetProvider`、**defaultAgentProvider 枚举拆分**、两个 ByProvider 闭合对象。
- `packages/events/protocol/schemas/topics/preferences/desktop-preferences.schema.json` 同步。
- 重新生成：`services/tuttid/api/generated/**`、`packages/clients/tuttid-ts/src/generated/**`、`packages/events/protocol/src/generated/**`。
- `services/tuttid/api/daemon_preferences.go`、`api/preferences/types.go` 与 desktop 偏好共享映射。

### WP3 Provider 状态与安装

- `services/tuttid/service/agentstatus/registry.go`：tutti-agent `ProviderSpec`。
- `service_helpers.go`：tutti-agent 鉴权解析分支（`tutti_llm`）。
- 安装器形态确认（npm 包产物是否含平台 optional-dep，决定是否复刻 `installer_codex_cli.go` 路径）。
- `agentstatus` 测试。

### WP4 Preparer 与 token bootstrap

- 新增 `services/tuttid/service/agentsidecar/tutti_agent.go`，注册进 `preparer.go`。
- daemon 侧 account/登录态集成点与 llm-token 签发、`login --with-tutti-llm-tokens` 执行、auth 校验。
- 测试：home/env/auth 物化；证明 token 不泄漏到渲染进程/activity/日志。

### WP5 App-server adapter 参数化

- `packages/agent/daemon/runtime/`：抽取 `AppServerAdapterConfig`，`codex_appserver_adapter.go` 改造为配置驱动；`types.go` 加 provider；`controller.go` 注册 tutti-agent adapter。
- `codex_appserver_events.go` 的 `appServerInfo` 支持 `tuttiAgentHome`。
- Codex 行为零变化（回归测试兜底，`codex_appserver_lifecycle_test.go` 等）。
- 决策 fork 对权限模式、collaboration mode、slash command、rate-limit、account 读取、fork/rollback 的支持面。

### WP6 模型目录与 composer

- `services/tuttid/service/agent/`：model lister 泛化、catalog 缓存分支、`composer_options.go` 各 switch（含裸字符串比较清理）。

### WP7 桌面 workbench 与 AgentGUI

- 开关接线：`useWorkspaceWorkbenchShellRuntime.tsx` 过滤 target/provider 列表；`workspaceWorkbenchContributionFactory.ts` / `workspaceAgentGuiContribution.ts` / `workspaceAgentProviderDockStateSource.ts` / `WorkspaceLaunchpadOverlay.tsx` 按需透传。
- 三个 provider 枚举 + providerCatalog / providerTargets（`localAgentGUIAgentTargetId`）/ dockIcons / fallback labels。
- `DesktopAgentGUIWorkbenchBody` 无需特殊改动（状态驱动），验证即可。
- 测试：`WorkspaceSettingsPanel.test.ts`、`workspaceSettingsService.test.ts`、`workspaceAgentGuiProviderTargets.test.ts`、`providerTargets.spec.ts`、`workspaceAgentProviderDockStateSource.test.ts`、`contribution.test.ts` 加开关开/关与历史会话行为用例。

### WP8 资产、应用 mention、i18n

- 图标三处注册表 + `agent-tutti-agent` 三处映射（均受开关闸门）。
- en/zh-CN 文案、`pnpm check:i18n`、`check:renderer-boundaries`、`check:ui-boundaries`。
- launchpad legacy "Tutti" 与 "Tutti Agent" 展示名冲突的产品决策落地。

## 7. 分阶段

### Phase 0：协议冒烟（先于任何 runtime 改动）

对 fork 跑脚本化冒烟：`tutti-agent app-server` → `initialize` → `model/list` → `thread/start` → `turn/start` →（若支持）interrupt。确认：

- initialize 返回 `tuttiAgentHome`；
- 模型列表反映网关实时授权（当前应只见 `gpt-5.4`）；
- 通知 schema 与现有 codex reducer 兼容；
- 鉴权缺失错误可区分。

### Phase 1：域模型、契约、隐藏的 UI 闸门（WP1/WP2/WP7 骨架）

验收：`local:tutti-agent` 持久化并出现在 `/v1/agent-targets`；开关关= dock/launchpad/rail/composer/mention 全无入口；开关开=入口出现且 createSession 携带 `agentTargetId: "local:tutti-agent"`；默认 provider 不会意外变成 tutti-agent。

### Phase 2：状态、安装、模型目录（WP3/WP6）

验收：status 端点返回 tutti-agent；安装动作走 `@tutti-os/tutti-agent`；auth_required 与 not_installed 可区分；composer 模型来自 `model/list`。

### Phase 3：runtime 与 preparer（WP4/WP5）

验收：runtime 拉起 `tutti-agent app-server`；`TUTTI_AGENT_HOME` 会话级隔离、不碰 Codex home；`tutti_llm` bootstrap 成功且渲染进程无 token 暴露；activity projection 全程保持 provider `tutti-agent`；Codex 回归全绿。

### Phase 4：产品打磨（WP8 + 契约收尾）

验收：文案全走 i18n；开关语义在 dock/launchpad/AgentGUI/settings/mention 一致；若开放默认 provider，开关关闭时的 settings 行为有明确规格与测试。

## 8. 备选方案对比

| 方案                                        | 结论                     | 理由                                                                                                                                               |
| ------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 当作 Codex 换皮（复用 provider "codex"） | 拒绝                     | 会话以 `provider:"codex"` 存储，污染分析/支持/过滤/target 语义；Codex 官方兼容性改动会波及 tutti-agent；originator 复用还有上游 allowlist 合规问题 |
| B. 复制整个 codex app-server adapter        | 拒绝（仅可作短期 spike） | ~93KB 高风险适配器（流式、工具、审批、server request、子线程、取消）双份维护，每个修复都要改两处                                                   |
| C. 参数化 app-server adapter（本方案）      | **推荐**                 | 保持 provider 身份独立，协议修复双方共享，契合 target-first 流；代价是需谨慎剥离硬编码并配回归覆盖，且仓库已有 `standardACPConfig` 成熟范式可循    |

## 9. 风险与开放问题

- **defaultAgentProvider 枚举拆分**是全量 provider 化的前置条件（4.6）。
- **鉴权误报**：无解析分支的 provider 会退化为 marker 文件存在即已鉴权；tutti-agent 必须有真实解析/bootstrap 校验（4.4）。
- **schema 兼容未验证**：Phase 0 冒烟必须先行；fork 的 `tuttiAgentHome` 字段已确认与现有 adapter 不兼容，需 4.2 的配置化解决。
- **client identity**：`codex_cli_rs` originator 严禁复用；fork 侧/网关侧对 originator 的要求需确认。
- **daemon 获取宿主登录态的集成点**未定：tuttid 如何拿到 `session_id`（或等价凭据）来签发 llm-token，需要与 account/桌面登录链路对齐。
- **refresh token rotate**：多 home/多会话并发时的 token family 归属需要单一属主或串行化策略；建议 bootstrap 时按 home 独立签发。
- **daemon 侧无闸门**：target seed 后 `/v1/agent-targets` 就会返回 `local:tutti-agent`；首版闸门只在 UI 入口层。若需要跨窗口/daemon 发布目录的一致性，应把开关从 localStorage 升级为 daemon desktop preferences（当前为渲染进程本地标志，多窗口间不同步是已知限制）。
- **展示名冲突**：已决策下线桌面新入口里的旧 legacy "Tutti" 伪应用；保留 legacy provider 仅用于历史/runtime provider identity 兼容。
- 不改 `tutti`→legacy provider 既有别名。
- 安装器形态取决于 `@tutti-os/tutti-agent@0.0.1` 的发布产物（是否 optional-dep 平台二进制）。

## 10. 验证矩阵

契约与生成物：

```sh
pnpm generate:api && pnpm check:api-generated
pnpm generate:event-protocol && pnpm check:event-protocol-generated
pnpm check:codexproto-generated
```

daemon/域：

```sh
pnpm lint:go
cd services/tuttid && go test ./... && go build ./...
go test ./packages/agent/daemon/runtime/...
```

AgentGUI 与 desktop：

```sh
pnpm --filter @tutti-os/agent-gui test
pnpm --filter @tutti-os/desktop test
pnpm check:i18n
pnpm check:renderer-boundaries
pnpm check:ui-boundaries
pnpm check:agent-activity-runtime-boundaries
```

手工验收：

- 开关关：所有 tutti-agent 新入口消失；既有会话仍可按 id 打开并渲染 transcript。
- 开关开：dock/launchpad/rail/composer 出现 Tutti Agent，createSession 携带 `agentTargetId: "local:tutti-agent"`，daemon 校验 provider/target 一致性。
- status/install/auth/probe 状态正确（not_installed → 安装 → auth_required → bootstrap → ready）。
- composer 模型菜单只显示 `model/list` 返回的授权模型（当前策略下即 `gpt-5.4`）。
- 全链路无 `session_id`、`lat_`、`lrt_` 出现在渲染进程状态、activity 快照、workbench 节点状态或日志。

## 文档影响

实现落地时同步更新：

- `docs/architecture/agent-gui-node.md`：若 AgentGUI 数据流、开关闸门、provider target 语义或历史会话行为变化。
- `docs/architecture/agent-activity-packages.md`：若 provider target、activity projection、adapter 或宿主/runtime 所有权变化。
- `docs/conventions/` 下 runtime/api 约定文档：若 `TUTTI_AGENT_HOME`、安装路径、provider 枚举生成规则成为用户可见行为。
- `docs/conventions/troubleshooting.md`：若鉴权 bootstrap、app-server 启动或网关失败成为高频运营问题。
