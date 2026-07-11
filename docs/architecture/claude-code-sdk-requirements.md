# Claude Code SDK 重构保真要求

本文定义 Tutti 中 Claude Code 集成的产品保真范围和重构验收边界。它描述的是必须长期成立的产品契约，不绑定旧代码结构。

Claude Code 只有一条运行链路：`tuttid` 启动 `@tutti-os/claude-sdk-sidecar`，sidecar 使用 Claude Agent SDK。不得增加运行时选择器、平行实现或仅供迁移期使用的第二套会话语义。

具体模块所有权和协议见 [Claude Code SDK Runtime](./claude-code-sdk-runtime.md)。

## 用户能力保真

### 安装、认证与状态

- 自动发现 Claude CLI、Node 和 SDK sidecar，展示安装、登录、版本、可用性和可恢复错误。
- 支持安装、登录、刷新，以及用户已有 Claude 订阅、Anthropic API Key、Auth Token 和兼容 endpoint。
- 展示账号套餐、会话与周额度、重置时间和 extra usage；自定义 API 配置允许 quota 不可用。
- 安装、登录、配置文件变化、运行时认证失败和账号切换后，provider 状态与模型目录必须同步失效和刷新。
- 所有可能刷新共享 OAuth credential 的启动操作必须串行，等待过程响应取消；隐藏模型发现不得破坏 token 旋转。
- macOS usage 读取必须以 Keychain 为主、`$CLAUDE_CONFIG_DIR/.credentials.json` 为兜底；AgentGUI 初次挂载不得访问 Anthropic usage API。

### 会话、历史与窗口

- 支持从 Agent Dock、Launchpad、Agent 提及及业务入口创建 Claude Code 会话。
- 支持项目目录和无项目会话、多会话、多工作台窗口及独立 Agent 窗口。
- 支持新建、恢复、重试、搜索、分页、重命名、置顶、删除、批量删除和在新窗口打开。
- 支持按项目、Chats、Pinned 和 Agent Target 浏览，并正确呈现运行、等待、完成、失败、取消和未读状态。
- 支持 Claude 本地历史导入，保留标题、项目、消息、最近模型和时间；重复导入必须幂等。
- 支持会话 handoff；多个窗口共享 daemon 中的同一份 durable session 和 activity 真相。

### Composer 与上下文

- 支持普通文本、多行文本、长文本托管附件、图片、文件、目录和结构化 workspace reference。
- 支持 Workspace App、产物、Issue、历史 Agent 会话和 Agent Target mention，并由对应 Tutti skill 路由。
- 发现项目技能、个人技能和 Tutti 注入技能；支持 Claude slash commands 和参数提示。
- 支持 `/compact`、`/context`、`/usage`、`/status`、`/fast`、`/plan`、`/goal` 和 `/review` 对应能力。
- 忙碌时支持提示词排队、编辑、删除和立即发送；guidance 进入当前 turn，不创建普通下一 turn。

### 设置与能力协商

- 模型目录优先使用 live session，回退到 auth-scoped last-known-good cache，再回退静态模型。
- 支持 Default、账号动态模型、自定义模型、reasoning effort、Standard/Fast、权限模式和 Plan Mode。
- 模型、reasoning、速度、权限和 Plan Mode 可在 live session 中更新；active session 设置不反写新会话默认值。
- 静态 composer profile 是预启动权威；会话启动后以 runtime capability 为权威。
- Runtime 必须报告 image input、compact、token usage、rate limits、plan mode、interrupt、skills、review 和 goal；仅在实际启用时报告 browser/computer。
- capability 不可用时，GUI 隐藏或禁用入口，daemon 同时拒绝越权调用。

### 执行、活动与交互

- 实时显示回答、thinking、工具输入/进度/输出/终态、计划、后台 Agent、嵌套 Agent 和 task notification。
- SDK 消息在 daemon 边界归一为稳定 session/message/turn/tool identity；GUI 不读取 sidecar stdout 或 SDK 日志补数据。
- Assistant/thinking 分段、工具生命周期、文件 diff、usage 和 compact boundary 必须可乱序对账且不能重复终态。
- 支持 Allow、Allow for session、Reject、AskUserQuestion 和 ExitPlanMode；pending interaction 具备 object/null/omitted 三态语义。
- 支持停止、goal set/show/clear/complete、上下文用量、手动 compact、Undo/Reapply 和生成文件再次引用。
- 后台 Agent 使用 tool call identity 作为主键，保留父子链；子 assistant 文本不能提前终结 task。

### Tutti 扩展能力

- 每会话在 run-scoped 目录生成 system prompt、Claude plugin、skills、manifest 和托管临时文件，不修改用户项目或用户 `.claude` 内容。
- 注入 `tutti-cli`、`tutti-handoff`、`issue-manager`、`workspace-app` 和 `reference`，按能力注入 browser/computer skill。
- Claude Code 可通过 Tutti CLI 访问 Workspace、Agent、Issue、Workspace App 和 reference bundle。
- Browser 由 daemon-owned `tutti browser` 路由；Computer 仅在开关、driver 和系统权限均满足时启用，启动时 fail fast 且不擅自弹授权框。

## 技术不变量

### 身份、所有权与持久化

- 兼容 provider 输入统一规范化为 `claude-code`；新会话必须携带可信 `agentTargetId`，daemon 校验 Target/provider 一致性。
- Tutti session、Claude provider session、turn、message 和 tool call id 各自稳定，不得互相替代。
- Provider 可用性、启动授权、会话生命周期、恢复、持久化和 activity 投影归 `tuttid`；Desktop 只拥有 Electron/host integration，AgentGUI 只消费规范化契约。
- Durable session 与 live process 分离。Idle release 只释放进程，不清 provider session id、resume cursor、历史活动或 runtime manifest。
- SQLite 投影和 `agent.activity.updated` 是跨窗口同步权威；optimistic prompt 只作为可对账 overlay。

### 原生配置与凭证安全

- 全链路尊重 `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_EXECUTABLE`、Anthropic credential、endpoint 和模型别名，不自行改写代理模型映射。
- SDK env 优先级为 sidecar process env、用户 settings、从根到 cwd 的项目 settings、daemon session env；损坏或缺失配置不得阻塞启动。
- 不得创建空配置目录隔离用户 credential，不得并发启动会触碰同一 OAuth refresh token 的 Claude 进程。
- 诊断只能记录 credential 是否存在、来源、过期信息和不可逆短 fingerprint；不得记录 token、prompt、账户名、个人路径、命令参数或异常堆栈原文。

### Sidecar 与生命周期

- Sidecar 以 raw TypeScript 和生产依赖交付，由 managed Node 使用 `--experimental-strip-types` 执行。
- Daemon 与 sidecar 使用带版本的 NDJSON；stdout 只承载协议，stderr 有界收集且必须经过敏感字段清理。
- 协议支持 `start`、`exec`、`guide`、`cancel`、`submit_interactive`、`apply_settings` 和 `close`；请求 ack 使用 request id 和超时。
- `close` 必须等待 SDK query 完成关闭并收到 sidecar ack 后再关闭进程输入；UI 等待超时不得强杀仍在初始化或落盘 credential 的 SDK 进程。
- 每 session 只有一个持续 reader；turn 返回后仍处理后台 task、title、usage 和 session state。
- Start、Resume 和替换 live process 必须具备失败回滚；Close/reader failure/cancel 必须终结 pending interaction 并释放资源。
- Provider session id 和 opaque resume cursor 必须持久化；不可恢复错误不得静默创建 shadow session。

### 输入与 Activity

- 文本和图片在 daemon/adapter/sidecar 之间保持结构化 content blocks；文本 prompt 只作为兼容 fallback。
- 图片和附件由 Tutti 托管；daemon 重新校验 realpath、symlink、类型、大小和 state-root 边界。
- 每条 transcript message 必须有稳定 message id、正 version/sequence、turn id 和时间。
- Tool use、stream update、hook 和 result 合并为同一 call id；Edit/Write 的最终 diff 以成功响应的 structured patch 为准。
- Turn lifecycle 具有单调序列和原子 settle；取消幂等，迟到事件不能复活已终结 turn 或后台 task。

### 打包与可观察性

- Desktop 最终资源包含 sidecar 源码、生产依赖、managed Node contract 和平台 Claude binary，不依赖 monorepo、全局 npm 或开发机 workspace。
- Vendor 完成后必须从 vendored 路径启动进程并跑通 start/exec/close；Electron `afterPack` 后必须从最终 Resources 路径再次执行同一冒烟协议。
- 关键路径用 workspace/session/turn 关联 provider probe、install/login、prepare、start/resume、submit、usage、模型失效、auth refresh、stderr 和 event reconcile。
- 旧 provider id、旧 workbench state、旧 session provider-only 数据、旧消息 payload 和旧导入记录只在读取边界兼容；新写入使用当前契约。

## 重构验收门

合入前至少覆盖以下回归面：

| 领域       | 必测场景                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| 探测与认证 | PATH/CLI/Node、安装、登录、API credential、自定义 endpoint、账号切换、OAuth 并发续期 |
| 生命周期   | 创建、恢复、失败回滚、idle release 后再附着、close、进程异常、event reconnect        |
| Composer   | 动态模型、live settings、skills、slash commands、browser/computer capability 降级    |
| 输入与活动 | 图片、附件、stream/thinking、tool/diff、审批、问题、后台与嵌套 Agent                 |
| 状态机     | compact、goal、cancel、guidance、busy queue、stop 后 queue suspension                |
| 持久化     | session/message/activity 对账、分页、历史导入、跨窗口同步、usage quota               |
| 发布       | vendored 路径启动、最终 Resources 路径启动、无仓库源码依赖、平台架构资源             |

局部修改先运行 sidecar/daemon/desktop 的针对性测试，再运行 `pnpm check:changed`。发布或大规模迁移完成时运行 `pnpm check:full`。
