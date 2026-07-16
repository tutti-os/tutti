# Agent Extension Package Design

Status: accepted target architecture; Phases 1–4 foundation and generic composer projection implemented

## Implementation review (2026-07-14)

The review accepted the core separation between declarative extension metadata
and out-of-process ACP runtime code, with these implementation clarifications:

- Agent Target presentation needs signed, daemon-cached `iconUrl` and optional
  `heroImageUrl`; retaining only built-in presentation catalogs would force
  extension-specific renderer changes.
- `builtin_local` is the canonical built-in launch-ref discriminator.
  `local_cli` is accepted only while reading legacy data and is never emitted.
- Open provider strings are validated at the daemon ingress. Unknown valid
  values are preserved through OpenAPI, Agent GUI, and Workbench and are not
  coerced to Codex.
- The first runtime implementation uses compatible local runtimes only.
  Project-local installation remains behind a future explicit confirmation API;
  enabling an extension must never silently mutate a project.
- A source-specific `versions.json` is sufficient for built-in rollout. The
  aggregate catalog remains a release-tool output for future discovery and does
  not become a second runtime source of truth.

Implemented in this change: open provider/Target contracts, discriminated
launch refs, Agent Target icon URLs, reproducible signed release tooling,
reusable S3 workflow, source defaults and env gate, signed catalog download,
safe atomic extension installation, offline installed-version fallback,
dynamic generic ACP adapter resolution, fixed-installation resume, and the
external Gemini extension repository.

Implemented in the compatibility follow-up: fixed-installation profile
validation, exact Target/project/installation-scoped composer discovery,
runtime-owned model/mode/reasoning catalogs, canonical reasoning aliases that
retain their ACP runtime ids, signed permission semantics, signed slash-command
narrowing with shared effects, and declared/runtime/host capability
intersection. Public composer responses now expose typed command and per-model
reasoning contracts; persisted `runtimeContext` remains an internal
legacy/diagnostic recovery source rather than a renderer-facing capability
channel. Hidden discovery remains bounded, prompt-free, single-flight, and is
closed on every terminal path. It is pre-session projection, not setup or
authentication state.

Still in compatibility migration: explicit project-scoped runtime installation,
ACP readiness/auth probing, composite session-pinned adapter/runtime/profile
fingerprints, richer tool/event profile rules, and removal of remaining
built-in provider catalogs. Declarative tool aliases, shared ACP diff
normalization, composer/capability projection, and permission semantic mapping
are implemented.
Remaining items must not be implemented with provider-specific Gemini branches.

## 1. 背景

Tutti 当前的 Agent provider、runtime adapter、Agent Target、桌面 provider 类型和部分 Agent GUI 展示策略仍由主仓编译期代码注册。

这一模式适合 Codex、Claude Code 等内置 Agent，但不适合第三方 Agent 独立开发和发布。即使第三方 Agent 已支持 Agent Client Protocol（ACP），当前仍需要修改 Tutti 主仓中的 provider descriptor、OpenAPI 枚举、runtime adapter 注册、图标、国际化和前端 provider 类型才能接入。

目标是建立 Tutti 自己的 Agent Extension Package 分发与运行协议：

- 第三方 Agent 在独立仓库开发并实现 ACP。
- 第三方仓库构建一个版本化 Agent 扩展包并发布到 S3/CDN。
- Tutti 主仓只登记扩展 `key`、release index URL、功能开关和签名身份。
- 开关开启后，`tuttid` 动态下载、校验、安装并注册 Agent。
- 扩展包同时描述 ACP runtime、工具语义、diff 规则、能力、composer 配置、展示方式和国际化资源。
- Agent GUI 继续消费统一的 Agent Activity 和 composer contracts，不为每个第三方 Agent增加 provider-specific 分支。

ACP 负责通信协议；Agent Extension Package 负责 Tutti 产品内的完整接入语义。

## 2. 设计原则

1. 第三方运行代码必须在独立 ACP 子进程中执行，不加载到 Electron renderer 或 `tuttid` 地址空间。
2. `agentTargetId` 继续作为 Agent GUI 选择、启动、过滤和 composer cache 的唯一身份。
3. `provider` 是开放的执行元数据，不再是编译期封闭枚举或 UI 目录身份。
4. provider 原始事件必须在 daemon runtime/activity 边界标准化后再持久化和展示。
5. diff、file changes、tool category 和交互语义不能由 React 组件根据 provider 名称推断。
6. 扩展包优先使用声明式配置；任意第三方 JavaScript、React renderer 和 Go plugin 均不允许动态加载。
7. 历史活动保存 canonical payload，不使用当前最新版扩展规则重新解释旧 raw payload。
8. release artifact 不可变，`latest.json`、`versions.json` 和 catalog metadata 可变。
9. 扩展安装必须固定版本、校验发布者身份和 artifact 内容。
10. 内置 Agent 的特殊策略继续作为可信内置 extension overlay，不要求强行改写为第三方配置。
11. Extension 安装和 Agent Runtime 安装是两个独立状态；扩展包不携带 Agent 可执行文件，兼容的用户本地 Runtime 必须优先于项目内安装的 Runtime。

## 3. 系统结构

```text
third-party Agent repository
  -> Agent Extension release tools
  -> S3 / CloudFront
  -> Agent Extension Catalog
  -> version / compatibility / signature selection
  -> Installation Manager
  -> Local Runtime Discovery
  -> Project-scoped Runtime Installer
  -> Agent Extension Registry
       -> Agent Target Directory
       -> ACP Runtime Binding
       -> Tool Semantic Normalizer
       -> Capability / Composer Profile
  -> canonical Agent Activity
  -> AgentSessionEngine
  -> Agent GUI
```

建议新增两个核心边界：

- `AgentExtensionCatalog` / `AgentInstallationManager`
- `AgentRuntimeResolver`

Agent GUI、AgentSessionEngine 和 durable activity persistence 不应被第三方包替换。

## 4. 主仓配置

主仓只配置可信扩展源：

```json
{
  "agentExtensions": [
    {
      "key": "gemini",
      "releaseIndexUrl": "https://cdn.example.com/tutti-agent-releases/agents/gemini/versions.json",
      "signingKeyId": "google-gemini-release-v1",
      "enabled": false
    }
  }
}
```

字段职责：

| 字段              | 说明                                  |
| ----------------- | ------------------------------------- |
| `key`             | Tutti 配置中稳定、唯一的扩展源 key    |
| `releaseIndexUrl` | 指向该扩展 `versions.json` 的 CDN URL |
| `signingKeyId`    | 主仓信任的发布者签名身份              |
| `enabled`         | 是否允许加载和运行该扩展              |

运行时/env override 必须进入对应的 durable configuration convention。例如：

```text
TUTTI_AGENT_EXTENSION_GEMINI_ENABLED=true
```

扩展包中的 `agentKey` 必须与主仓配置的 `key` 一致。远端 manifest 不能覆盖本地信任配置、功能开关或 signing key。

## 5. S3/CDN 发布结构

沿用 Workspace App Release 的 immutable release 和 mutable index 模式，使用独立 Agent namespace：

```text
agents/<agentKey>/<version>/
  <agentKey>-<version>.zip
  release.json

agents/<agentKey>/latest.json
agents/<agentKey>/versions.json

catalog.json
```

建议 schema：

```text
tutti.agent.manifest.v1
tutti.agent.release.v1
tutti.agent.versions.v1
tutti.agent.catalog.v1
```

发布工具必须随具体 Agent 仓库版本化，例如：

```text
agent-extension-gemini/scripts/release/
```

Tutti 主仓只消费和验证发布结果，不提供第三方 Agent 的构建、签名或上传
workflow。通用目录结构、脚手架和发布约束由
`tutti-os/tutti-agent-extension-skill` 维护。

发布工具负责：

- 校验 `tutti.agent.json` 及其引用资源。
- 创建稳定排序、稳定时间戳的可重复 zip。
- 计算 artifact SHA-256 和文件大小。
- 生成 immutable `release.json`。
- 更新 mutable `latest.json` 和 `versions.json`。
- 维护 `minTuttiVersion`、required host capabilities 和 active/withdrawn 状态。
- 生成或合并 `tutti.agent.catalog.v1`。
- 使用 S3 ETag precondition 更新 mutable metadata。
- 下载并验证已经上传到 CDN 的 release artifact。
- 支持 release-only、release-and-catalog 和 catalog-only 三种发布模式。

## 6. 扩展包结构

推荐包结构：

```text
tutti.agent.json
AGENTS.md

assets/
  icon.svg
  hero-image.jpg

locales/
  en.json
  zh-CN.json

profiles/
  discovery.json
  tools.json
  capabilities.json
  composer.json
  events.json

```

只有 `tutti.agent.json` 必需。其他文件由 manifest 显式引用，未引用的文件不能影响运行时行为。扩展包只能包含声明式配置、assets 和 locales，不能包含 Agent executable、安装脚本、WASM normalizer 或其他可执行代码。

## 7. Agent manifest

示例：

```json
{
  "schemaVersion": "tutti.agent.manifest.v1",
  "agentKey": "gemini",
  "version": "1.0.0",
  "name": "Gemini CLI",
  "description": "Google Gemini CLI through ACP",
  "icon": {
    "type": "asset",
    "src": "assets/icon.svg"
  },
  "heroImage": {
    "type": "asset",
    "src": "assets/hero-image.jpg"
  },
  "runtime": {
    "kind": "standard-acp",
    "install": {
      "runner": "npm",
      "args": [
        "install",
        "--prefix",
        "${installRoot}",
        "@google/gemini-cli@0.50.0"
      ]
    },
    "launch": {
      "executable": "${installRoot}/node_modules/.bin/gemini",
      "args": ["--acp"]
    }
  },
  "profiles": {
    "discovery": "profiles/discovery.json",
    "tools": "profiles/tools.json",
    "capabilities": "profiles/capabilities.json",
    "composer": "profiles/composer.json",
    "events": "profiles/events.json"
  },
  "localizationInfo": {
    "defaultLocale": "en",
    "additionalLocales": [
      {
        "locale": "zh-CN",
        "file": "locales/zh-CN.json"
      }
    ]
  }
}
```

`icon` 是 Agent 的全局身份图标，不只用于 Agent 选择器：host 必须把验证后的
本地资源投影为 Target `iconUrl`，供 provider rail、会话列表、消息中心和 @
引用等共享展示使用。扩展不需要再声明 provider 专用或会话专用图标字段；这些
界面也不能要求开放 provider 在 renderer 静态图标表中注册。

第三方 manifest 不能选择 Tutti 内部的 Codex app-server、Claude SDK、Cursor special strategy 等可信 adapter strategy。第三方 baseline 只允许 `standard-acp`。

## 8. Runtime discovery 和标准安装命令

Extension package 只安装 manifest、profiles、assets 和 locales，不携带或解压任何 Agent executable。`runtime.install` 只是本地探测失败后的项目内安装声明，不是默认启动来源。

### 8.1 本地 Runtime Discovery

`profiles/discovery.json` 描述通用、本地优先的探测规则：

```json
{
  "schemaVersion": "tutti.agent.discovery.v1",
  "candidates": [
    {
      "binaryNames": ["gemini"],
      "version": {
        "args": ["--version"],
        "constraint": ">=0.50.0"
      },
      "launchArgs": ["--acp"],
      "probe": {
        "kind": "acp-initialize",
        "timeoutMs": 3000
      }
    }
  ]
}
```

探测顺序固定为：

1. 用户为该 Agent Target 显式选择的可执行文件路径。
2. Discovery Profile 中声明、且由 Tutti runtime command resolver 找到的本地候选。
3. 当前项目下已安装、已验证的 project-local Runtime。
4. 没有可用 Runtime 时提供项目内安装操作。

本地候选必须依次通过以下检查才能成为 runtime binding：

- 路径存在且是当前用户可执行的普通文件；
- 版本命令成功，且版本满足 extension compatibility；
- 使用 argv 数组直接构造 ACP 启动命令，不经过 shell；
- ACP `initialize`/handshake 在限定时间内成功；
- 协商出的能力与 extension 声明存在可用交集。

仅发现同名文件不能判定 Agent `ready`。版本不兼容、ACP 启动失败和认证未完成必须保留为不同状态，供 Agent GUI 展示准确原因和操作。

Discovery Profile 只允许声明受限的路径候选、argv、版本解析、ACP probe 和认证状态规则，不能声明任意探测脚本。Tutti 现有 runtime command resolver 对 `PATH`、Homebrew、pnpm、Volta、asdf、mise、fnm、nvm 和常见用户 bin 目录的处理应继续作为统一底层能力，第三方 extension 不重复实现文件系统扫描。

### 8.2 标准安装命令

扩展 manifest 声明受限的 install runner 和 argv。Tutti 负责解析 runner、替换受控 placeholder、展示最终命令并以 argv 方式直接执行，不通过 shell。

首版只开放 Tutti 明确支持的 runner，例如：

- `npm`：使用 Tutti 已解析的 npm/Node Runtime；
- `pnpm`：仅在 Tutti 能解析可信 pnpm executable 时开放；
- `uv`：使用 Tutti 已解析的 uv Runtime；
- 后续新增 runner 必须扩展 schema 和 host executor，不能由 manifest 自定义 executable。

允许的 placeholder 只包括 Tutti 计算的 `${projectRoot}`、`${installRoot}` 和平台标识。禁止 `${HOME}`、任意环境变量展开、命令替换、管道、重定向、`curl | sh`、`bootstrap.sh` 或用户输入拼接。

安装根目录固定为当前项目下的 Tutti-owned 隔离目录：

```text
<projectRoot>/.tutti/agent-runtimes/<agentKey>/<extensionVersion>/
```

标准安装命令的工作目录是 `<projectRoot>`，但 package manager 的 prefix、target 或 environment 必须指向 `<installRoot>`。安装不得修改项目的 `package.json`、lockfile、Python environment 或全局 package manager 状态。`.tutti/agent-runtimes` 是生成目录，应由项目忽略策略排除版本控制；Tutti 不应在未确认时修改用户的 `.gitignore`。

安装完成后必须从 manifest 的 `runtime.launch` 解析项目内 executable，再执行与本地候选相同的版本检查和 ACP handshake。只有 probe 成功才能原子切换为 active project runtime binding。

包管理器安装可能执行第三方 package lifecycle code。Agent 本体本来就是第三方可执行代码，因此首次项目安装前必须展示发布者、精确版本、最终命令、安装目录和风险，并要求用户确认；后台自动更新只能在用户明确启用该策略后发生。

## 9. 安装模型

Extension Installation Manager 只管理轻量 Extension 元数据。Project Runtime Installer 管理当前项目下由标准安装命令生成的 Runtime。开启扩展后先下载并验证 manifest/profile；只有本地 Discovery 没有找到兼容 Runtime、当前已选择有效项目且用户允许时，才执行 `runtime.install`。

建议的核心接口：

```go
type AgentExtensionInstallationManager interface {
    Install(ctx context.Context, key string, release AgentRelease) (Installation, error)
    Upgrade(ctx context.Context, installationID string, release AgentRelease) (Installation, error)
    Uninstall(ctx context.Context, installationID string) error
}

type ProjectAgentRuntimeInstaller interface {
    Install(ctx context.Context, workspaceID string, projectRoot string, extensionInstallationID string) (ProjectRuntimeInstallation, error)
    Remove(ctx context.Context, workspaceID string, projectRoot string, agentTargetID string) error
}
```

Installation 至少保存：

- extension key；
- extension package version；
- manifest 和 profile digest；
- release source URL；
- artifact SHA-256；
- publisher signing identity；
- install runner/argv 和 launch digest；
- 安装状态和错误；
- 创建、更新时间。

ProjectRuntimeInstallation 至少保存：

- workspace ID 和 normalized project root；
- agent target ID、extension key/version/profile digest；
- install runner 和最终 argv digest；
- project-local install root；
- detected runtime version、executable path、fingerprint 和 package integrity；
- probe result、安装状态和错误。

Extension 安装采用新目录准备、完整验证、原子切换。项目 Runtime 先安装到 `<installRoot>.staging-*`，probe 成功后再原子切换为项目 active binding。升级不能覆盖当前运行 session 正在使用的 extension profile 或 project runtime 文件。

Runtime binding 作为独立记录保存：

- `source`：`local` 或 `project`；
- resolved executable path；
- detected runtime version；
- executable fingerprint；
- discovery profile digest；
- probe result 和 probe 时间；
- project runtime installation ID，仅 `project` 来源存在。

## 10. Agent Target 注册

扩展安装成功后，由 daemon 创建或更新 Agent Target：

```text
agentTargetId: extension:gemini
provider: acp:gemini
launchRef:
  type: agent_extension
  extensionInstallationId: agent-extension:gemini@1.0.0
```

Target launch ref 改为 discriminated union：

```yaml
AgentTargetLaunchRef:
  oneOf:
    - type: builtin_local
      provider: string
    - type: agent_extension
      extensionInstallationId: string
```

规则：

- `agentTargetId` 是 UI 和 launch identity。
- `provider` 是开放字符串，例如 `acp:gemini`。
- daemon 从可信 target 派生 extension installation、runtime binding 和 provider。
- renderer 不能提交 runtime command、installation path 或 credential。
- 同一 provider 下允许存在多个 Agent Target。
- provider-only fallback 只用于明确的 legacy migration，不能参与新会话创建。

## 11. 动态 runtime adapter resolution

Controller 当前的固定 `map[provider]Adapter` 应抽象为：

```go
type AgentRuntimeResolver interface {
    Resolve(ctx context.Context, input AgentRuntimeResolveInput) (Adapter, error)
}

type AgentRuntimeResolveInput struct {
    Provider          string
    AgentTargetID     string
    WorkspaceID       string
    ProjectRoot       string
    ProviderTargetRef map[string]any
}
```

解析顺序：

1. 查找内置 adapter。
2. 从 `agent_extension` target 解析固定 extension installation。
3. 执行或读取该项目作用域的 Runtime Discovery，按用户显式路径、本地候选、project-local 版本的顺序选择 runtime binding。
4. 根据已校验 manifest 和 runtime binding 创建 generic standard ACP adapter。
5. 绑定 command、event、config option 和 interactive disposition sinks。
6. 按 extension version、profile digest、runtime source、runtime fingerprint 缓存 adapter。

缓存键不能只使用 provider。至少包含 workspace ID、normalized project root、agent target ID、extension/profile 版本和 runtime fingerprint；不同项目不能共享错误的 project runtime binding。

探测在 `tuttid` 执行并由 provider-status service 持有事实状态。Agent GUI 和 Desktop React effects 不扫描 PATH、不执行版本命令，也不直接启动 probe；Desktop 只负责订阅渐进式状态并投影到具体 `agentTargetId`。

动态 Agent 状态至少需要覆盖：

- `detecting`；
- `ready`；
- `not_found`；
- `version_incompatible`；
- `acp_probe_failed`；
- `auth_required`；
- `installing`；
- `error`。

状态同时返回 `runtimeSource`、project root、已探测版本、可执行文件路径、失败 reason code 和服务端允许的 actions。Agent GUI 使用 extension locale/presentation profile 渲染“使用本地版本”“安装到当前项目”“选择其他路径”“重新探测”等操作，不包含 Agent-specific 判断。

由于安装作用域是项目，provider-status service 的动态 Extension 状态也必须以 `workspaceID + normalized projectRoot + agentTargetId` 为 key。Agent GUI 切换项目时重新读取对应状态：项目 A 的 `ready` 不能让项目 B 被误判为已安装。没有选择项目且未发现用户本地 Runtime 时，状态为 `project_required`，只提供选择项目，不允许退化为全局安装。

## 12. Tool semantic profile

ACP tool call 的 tool ID 和 payload 由 Agent 自己定义。扩展包必须能够将这些 provider raw payload 映射到 Tutti canonical activity。

示例 `profiles/tools.json`：

```json
{
  "schemaVersion": "tutti.agent.tools.v1",
  "tools": [
    {
      "match": {
        "ids": ["replace", "edit_file"]
      },
      "canonicalId": "Edit",
      "category": "file-change",
      "presentation": {
        "renderer": "diff",
        "titleKey": "tools.edit.title"
      },
      "fileEffect": {
        "path": {
          "source": "input",
          "path": "$.file_path"
        },
        "before": {
          "source": "output",
          "path": "$.before"
        },
        "after": {
          "source": "output",
          "path": "$.after"
        },
        "patch": {
          "source": "output",
          "path": "$.diff",
          "format": "unified"
        }
      }
    },
    {
      "match": {
        "ids": ["run_shell_command"]
      },
      "canonicalId": "Bash",
      "category": "command",
      "presentation": {
        "renderer": "terminal"
      },
      "command": {
        "source": "input",
        "path": "$.command"
      }
    }
  ]
}
```

处理链路：

```text
raw ACP tool call/update
  -> session-pinned Agent Extension profile
  -> canonical tool ID and call type
  -> canonical command/file/interaction data
  -> fileChanges and patchBatches
  -> durable activity persistence
  -> Agent GUI built-in renderer
```

Tool matching v1 优先支持 exact IDs 和受限 glob，不开放任意正则或表达式执行。JSON path 使用受限、只读的 extractor vocabulary。

## 13. Diff 和 file change 处理

diff 不能由 Agent GUI 根据 tool ID 临时推断。支持三个层级。

### 13.1 Agent 输出 canonical metadata

推荐第三方 Agent 在 ACP tool output 的 `_meta` 中直接输出：

```json
{
  "_meta": {
    "tutti": {
      "fileChanges": [
        {
          "path": "src/index.ts",
          "changeType": "modified",
          "diff": "--- a/src/index.ts\n+++ b/src/index.ts\n..."
        }
      ]
    }
  }
}
```

输出仍需 daemon schema validation，不能直接作为可信持久化对象。

### 13.2 声明式提取和计算

Tool profile 可描述：

- cwd 和 path 的来源；
- before/after 内容；
- unified diff；
- structured hunks；
- 多文件数组；
- 新增、修改、删除、重命名；
- tool success/failure status 映射。

Daemon 使用内置、可测试的 diff engine 生成 canonical `fileChanges` 和 `patchBatches`。

### 13.3 不加载动态 normalizer

Extension artifact 不携带 WASM、JavaScript 或其他可执行 normalizer。声明式规则无法表达的 raw payload 使用 generic tool presentation，并记录统一前缀的结构化诊断日志；新增归一化原语必须先进入 Tutti 内置、可测试的 canonical normalizer vocabulary，再由 profile 选择。

## 14. Presentation profile

第三方扩展不能提供 React renderer。扩展只能选择 Tutti 内置 renderer vocabulary：

```text
generic
terminal
diff
code
markdown
file-list
key-value
todo-list
web-search
web-fetch
image
approval
question
plan
mcp
```

示例：

```json
{
  "presentation": {
    "renderer": "key-value",
    "summary": {
      "template": "{input.query}"
    },
    "fields": [
      {
        "labelKey": "tools.search.query",
        "source": "input",
        "path": "$.query"
      },
      {
        "labelKey": "tools.search.resultCount",
        "source": "output",
        "path": "$.results.length"
      }
    ]
  }
}
```

Daemon 应尽可能把 presentation 需要的数据投影成 canonical `rendererKind + renderData`。Agent GUI 只选择内置组件，不重新解析 provider raw payload。

未知 tool 或 profile 失败时必须使用 generic renderer，保留 tool name、status 和可折叠 raw diagnostic data，但不能伪装成已识别的 edit、approval 或 question。

## 15. Capability profile

能力分为：

```text
declaredCapabilities
negotiatedCapabilities
effectiveCapabilities
```

示例：

```json
{
  "schemaVersion": "tutti.agent.capabilities.v1",
  "declared": {
    "imageInput": true,
    "interrupt": true,
    "resume": true,
    "permissionModes": true,
    "modelSelection": true,
    "tokenUsage": false,
    "rateLimits": false,
    "planMode": false,
    "skills": false,
    "undoReapply": true
  }
}
```

最终能力原则：

```text
effective capability
  = package declaration
  ∩ ACP runtime negotiation
  ∩ current Tutti host capability
```

对于非 ACP 标准能力，必须额外满足实现条件。例如：

```text
effective.undoReapply
  = declared.undoReapply
  && tool normalization produced executable patch data
  && daemon Git patch service is available
```

Manifest 声明不能覆盖实际 ACP handshake，也不能开启当前 host 不支持的能力。

## 16. Composer profile

`profiles/composer.json` 将标准 ACP config options 和 session modes 映射到 Agent GUI composer contract。

```json
{
  "schemaVersion": "tutti.agent.composer.v1",
  "configOptions": {
    "model": {
      "acpOptionId": "model"
    },
    "permission": {
      "acpOptionId": "approval-mode"
    },
    "reasoning": {
      "acpOptionId": "reasoning-effort"
    }
  },
  "permissionModes": [
    {
      "runtimeId": "default",
      "semantic": "ask-before-write"
    },
    {
      "runtimeId": "auto_edit",
      "semantic": "accept-edits"
    },
    {
      "runtimeId": "yolo",
      "semantic": "full-access"
    }
  ],
  "slashCommands": {
    "commandCatalogAuthoritative": true,
    "commands": [
      {
        "name": "compact",
        "effect": "submitImmediate"
      },
      {
        "name": "status",
        "effect": "showStatus"
      }
    ]
  },
  "skills": {
    "invocation": "textTrigger",
    "triggerPrefix": "/",
    "roots": [
      {
        "scope": "workspace",
        "path": ".agent/skills"
      },
      {
        "scope": "user",
        "path": ".agents/skills"
      }
    ]
  }
}
```

`configOptions` is the canonical profile shape. During compatibility migration,
the loader also accepts the earlier top-level `model` and `permission` source
objects. These declarations identify or constrain ACP fields; they do not
manufacture models, modes, values, labels, or commands absent from the current
runtime catalog.

Known permission semantics are `ask-before-write`, `accept-edits`, `auto`,
`locked-down`, `full-access`, and the plan-only `read-only` mapping. The composer
projects a supported runtime value as its Tutti semantic tier, while the generic
adapter retains and writes the signed `runtimeId`. Runtime values absent from
the signed mapping are not admitted. Reasoning option ids
`thought_level`, `effort`, and `model_reasoning_effort` project as
`reasoning_effort`, with deterministic alias precedence and the original id
retained for ACP writes. Unrelated runtime options such as `sandbox` remain
opaque provider-native context.

`slashCommands.commandCatalogAuthoritative` narrows the runtime-advertised
catalog. It cannot admit a command the runtime did not advertise. Runtime
descriptions and input hints survive filtering, while effects select only
shared host behaviors.

`skills.roots` 是扩展拥有的声明式 Skill discovery contract。`scope` 只能是
`workspace` 或 `user`，`path` 必须是安全的相对路径；host 分别从当前工作目录的
祖先和用户目录解析，扩展不能声明任意绝对路径。`invocation` 与
`triggerPrefix` 决定 composer 如何生成可执行 token，不能根据开放 provider ID
在 Tutti 内置表中补规则。

Runtime 返回的 model、mode、reasoning 和 command labels 优先使用 ACP 自带 label。扩展 locale 用于 Tutti-owned presentation copy，不能用 raw provider value 代替用户可见标签。

ACP `available_commands_update` 同时进入实时 session command snapshot 和 session
runtime context。Composer 优先使用实时 snapshot；若 renderer 错过启动期事件或
应用重启，daemon 可以从运行会话的 `availableCommands` 恢复相同 catalog。旧状态
只有 `commands: string[]` 时可以恢复名称，但不能伪造描述或 input hint。恢复后，
公开 composer-options 合约只通过 typed `commands` 返回 catalog；renderer 不解析
`runtimeContext`。Model-specific reasoning profile 同样通过 typed
`reasoningOptionsByModel` 返回，typed top-level fields 是唯一权威投影来源。

## 17. Authentication

Generic ACP adapter 必须支持标准认证链路：

```text
initialize.authMethods
  -> Agent availability = auth_required
  -> user selects authentication method
  -> ACP authenticate
  -> refresh probe
  -> ready or explicit failure
```

扩展包只能声明认证展示提示或首选 method ID，不能携带明文 credential。认证状态和 action 由 daemon/runtime 产生，Agent GUI 只呈现标准 readiness action。

## 18. Internationalization and assets

所有用户可见文本必须来自扩展 locale 或现有 Tutti i18n：

```json
{
  "agent.name": "Gemini CLI",
  "tools.edit.title": "Edited file",
  "tools.search.query": "Query",
  "tools.search.resultCount": "Results"
}
```

规则：

- 默认 locale 必须完整。
- 缺失当前 locale 时回退默认 locale。
- 缺失默认 key 时拒绝 package 或使用明确 generic copy，不能展示 raw i18n key。
- Icon 与可选首页海报在安装阶段缓存到 daemon-owned local asset storage，
  并通过 Agent Target 的 `iconUrl` / `heroImageUrl` 投影给 host。
- Renderer 不直接依赖第三方 CDN 展示素材的 CORS、可用性或可变内容，
  也不按第三方 provider 硬编码海报映射。

## 19. Session 和历史版本固定

Session 创建时必须固定扩展版本：

```json
{
  "agentExtension": {
    "key": "gemini",
    "version": "1.0.0",
    "profileDigest": "sha256:...",
    "runtimeBinding": {
      "source": "local",
      "path": "/resolved/path/to/gemini",
      "version": "0.50.0",
      "fingerprint": "sha256:..."
    }
  }
}
```

目的：

- 旧 tool ID 不会被新 profile 错误解释。
- 历史 diff 不会因扩展升级改变。
- Resume 使用兼容的 runtime binding。
- 运行中的 session 不受原子升级影响。

Canonical activity 写入持久化后，历史页面不再依赖 extension profile。只有 resume、新 runtime event normalization 和未标准化 legacy data compatibility 才需要固定 profile。

project-local Runtime 可以按不可变 installation ID 精确固定。用户全局/本地 Runtime 可能被用户或包管理器原地升级，因此只能固定探测到的 path、version 和 executable fingerprint：

- 已运行 ACP 子进程继续使用创建时的进程，不受磁盘文件变化影响；
- 新 session 必须重新探测本地 Runtime；
- Resume 前 fingerprint 变化时重新执行版本和 ACP probe；
- 本地 Runtime 已变化且无法满足原 session 兼容范围时，返回 `runtime_changed`，由 Agent GUI 提供安装/使用当前项目版本或创建新 session 的操作，不能静默切换行为。

## 20. 安全模型

主仓 source 配置至少包含 key、URL、feature flag 和 signing key identity。

安装校验顺序：

1. 只允许配置中授权的 HTTPS/CDN source。
2. 校验 release metadata 签名和 publisher identity。
3. 校验 artifact SHA-256 和 size。
4. 防止 zip path traversal、symlink escape 和压缩炸弹。
5. 校验 manifest schema、key、version 和 release metadata 一致。
6. 校验所有 profile schema 和引用路径。
7. Extension artifact 不允许包含 executable、安装脚本或 WASM。
8. install runner 必须来自 Tutti allowlist，argv 逐项校验，禁止 shell 语法和未授权 placeholder。
9. 安装命令中的 package 必须固定精确版本，并记录 package integrity。
10. install root 和 launch executable 必须位于当前项目的 `.tutti/agent-runtimes` 边界内。
11. 过滤继承环境变量；credential 通过明确的 daemon-owned auth/credential flow 提供。
12. 安装到 staging 目录，版本检查和 ACP probe 完成后原子切换 active installation。

SHA-256 只能证明下载内容没有变化，不能证明发布者身份，因此不能替代签名。

## 21. Failure 和 fallback

失败必须显式分类：

```text
catalog_unavailable
release_incompatible
signature_invalid
artifact_invalid
manifest_invalid
installation_failed
project_required
runtime_missing
protocol_incompatible
authentication_required
profile_invalid
normalization_failed
```

行为：

- Catalog 暂时不可用时可继续使用已验证、已 pin 的 Extension 和 project runtime installation。
- 项目内新安装失败不能破坏该项目上一 active runtime installation，也不能影响其他项目。
- Profile 无法识别一个 tool 时回退 generic tool renderer。
- Diff 解析失败不能伪造空 diff 或错误 file change。
- Missing capability 保持 unsupported/unknown，不从 provider 名称猜测。
- Missing extension 的历史 session 保持只读；不能回退到其他 provider 继续执行。

## 22. 发布者工作流

第三方仓库只需要：

```text
implement ACP Agent
  -> add tutti.agent.json and profiles
  -> package Agent Extension
  -> validate locally
  -> publish immutable release to S3
  -> update versions.json
  -> optionally merge catalog.json
```

推荐复用 GitHub OIDC、S3 和 CloudFront，但 workflow 和发布脚本必须放在
具体 Agent 仓库中：

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: pnpm install --frozen-lockfile
      - run: pnpm package:tutti-agent
      - run: node scripts/release/bin/build-tutti-agent-extension-release.mjs
```

生产发布由 Agent 仓库自己的 workflow 根据 packaged manifest 和输入版本生成
immutable release；不要求向受保护分支写回版本提交，也不依赖 Tutti 主仓发布。

## 23. Gemini 示例

第三方 Gemini extension package：

```json
{
  "schemaVersion": "tutti.agent.manifest.v1",
  "agentKey": "gemini",
  "version": "1.0.0",
  "name": "Gemini CLI",
  "runtime": {
    "kind": "standard-acp",
    "install": {
      "runner": "npm",
      "args": [
        "install",
        "--prefix",
        "${installRoot}",
        "@google/gemini-cli@0.50.0"
      ]
    },
    "launch": {
      "executable": "${installRoot}/node_modules/.bin/gemini",
      "args": ["--acp"]
    }
  },
  "profiles": {
    "discovery": "profiles/discovery.json",
    "tools": "profiles/tools.json",
    "capabilities": "profiles/capabilities.json",
    "composer": "profiles/composer.json"
  }
}
```

Tutti 主仓：

```json
{
  "key": "gemini",
  "releaseIndexUrl": "https://cdn.example.com/tutti-agent-releases/agents/gemini/versions.json",
  "signingKeyId": "google-gemini-release-v1",
  "enabled": false
}
```

开启后：

```text
fetch versions.json
  -> select compatible Gemini extension
  -> verify and install lightweight extension metadata
  -> register extension:gemini Agent Target
  -> show Gemini in Agent GUI directory
  -> detect local gemini binary and verify version + ACP handshake
  -> use compatible local Gemini CLI when available
  -> otherwise require a selected project
  -> show exact npm command and request install confirmation
  -> install pinned @google/gemini-cli under <project>/.tutti/agent-runtimes
  -> verify the project-local binary and bind it only for that project
  -> normalize Gemini tool IDs and file changes
  -> render through built-in Agent GUI components
```

Tutti 主仓不需要新增 Gemini-specific runtime adapter、React component 或 provider enum。

## 24. 分阶段实施

### Phase 1：开放身份和 contract

- OpenAPI 中 runtime provider 改为开放字符串。
- Agent Target launch ref 改为 discriminated union。
- Agent GUI/Workbench provider 类型改为开放字符串或 branded string。
- 删除 unknown provider 回退 Codex。
- `agentTargetId` 成为 workbench launch 和 persisted state 的主身份。

### Phase 2：Extension package 和 release tooling

- 定义 manifest、release、versions 和 catalog schema。
- 在每个具体 Agent 仓库中加入自包含的 release tools 和 workflow。
- 实现可重复 zip、SHA-256、signature 和 compatibility validation。
- 在 `tutti-agent-extension-skill` 中提供发布模板、说明和验证规则。

### Phase 3：Catalog、安装和 Target 注册

- 新增 daemon Agent Extension Catalog。
- 新增 Extension Installation persistence 和 manager。
- 扩展包拒绝 executable、安装脚本和 WASM，只接受 manifest、profiles、assets 和 locales。
- Extension metadata 安装成功后注册 Agent Target 和本地 icon，不要求此时已安装 Agent Runtime。

### Phase 4：Dynamic runtime resolution

- 引入 `AgentRuntimeResolver`。
- 引入声明式 Discovery Profile，复用现有 runtime command resolver 和 provider-status 渐进探测链路。
- 新增 project-scoped Runtime Installation persistence 和受限 standard-command executor。
- 按用户显式路径、本地 Runtime、project-local Runtime 的优先级形成 runtime binding。
- Generic standard ACP adapter 从固定 extension installation 和 runtime binding 创建。
- Controller 以 workspace/project/target/extension/profile/runtime fingerprint 缓存 adapter。
- 补齐标准 ACP authenticate 流程。

### Phase 5：Tool、diff 和 capability profiles

- 定义声明式 extractor 和 renderer vocabulary。
- 在 daemon runtime/activity 边界执行 normalization。
- 持久化 canonical tool payload、file changes 和 patch batches。
- 由 runtime handshake 和 manifest 共同计算 effective capabilities。

### Phase 6：清理旧路径

- 删除动态 Agent 经过静态 provider allowlist 的路径。
- 删除新会话中的 provider-to-local-target fallback。
- Review 并删除重复 name/icon/status/composer catalogs。
- 保留内置 provider strategy 仅用于真正的内置特殊行为。
- 更新 Agent GUI、runtime、安装、安全和 troubleshooting durable docs。

## 25. 验收标准

使用一个完全位于 Tutti 主仓之外的 ACP Agent 仓库验证：

- 第三方仓库能够独立构建并发布 Agent Extension zip。
- 主仓只增加 key、CDN URL、feature flag 和 signing key 配置。
- 开关关闭时不下载、不安装、不展示 Agent。
- 开关开启后无需重新编译 provider adapter 即可安装和展示。
- Agent Extension zip 不包含 executable、安装脚本或 WASM。
- 用户已安装兼容 ACP Agent 时优先使用本地 Runtime，不执行项目安装命令。
- 用户本地未安装时，在当前项目的 `.tutti/agent-runtimes` 隔离目录执行已确认的标准安装命令。
- 安装命令不修改项目 package manifest、lockfile、Python environment 或全局 package manager 状态。
- 同一 Agent 在不同项目中的安装和探测状态相互隔离。
- 本地 Runtime 不兼容或 ACP probe 失败时，Agent GUI 展示准确状态和可执行操作。
- 支持 create、prompt、stream、tool call、permission、question 和 cancel。
- 支持标准 ACP authenticate。
- Tool ID 能通过动态 profile 映射为 canonical tool。
- 文件修改能生成正确 file changes、diff 和可执行 patch batches。
- Agent GUI 使用内置 renderer 正确展示工具。
- 未识别工具使用 generic renderer，不影响会话继续运行。
- Daemon 重启后能够使用固定 installation 恢复 session。
- CDN 不可用时已安装版本仍可运行。
- 扩展升级不影响运行中的旧 session。
- 历史 activity 不因 profile 升级改变展示语义。
- 签名、SHA、schema 或 compatibility 不合法时拒绝安装。

## 26. 非目标

- 不允许第三方扩展替换 AgentSessionEngine。
- 不允许第三方扩展直接写 durable session/activity 数据库。
- 不允许第三方扩展加载 React UI 代码。
- 不允许第三方扩展加载 Go plugin 或 daemon in-process module。
- 不承诺仅凭配置支持任意非 ACP Agent。
- 不把 provider-specific raw payload 变成 Agent GUI 的长期公共 contract。
- 不允许 manifest 自行扩大 Tutti host capabilities 或绕过用户开关。

## 27. 文档影响

实施本方案时至少需要同步更新：

- `docs/architecture/agent-gui-node.md`
- Agent Activity/runtime ownership 文档
- Agent Target 和 OpenAPI contract 文档
- 新的 Agent Extension package/release convention
- Runtime/config/env override convention
- Agent provider setup 和 runtime troubleshooting 文档
- S3/CDN、签名、安装目录和本地状态安全约定

本文件在方案进入实施后应从 `proposal` 更新为 durable target architecture，并明确记录已完成和仍处于兼容迁移阶段的边界。
