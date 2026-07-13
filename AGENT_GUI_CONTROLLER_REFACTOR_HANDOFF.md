# Agent GUI 基建重构交接说明

> 更新时间：2026-07-11
>
> 状态：架构重构已完成。协议、provider descriptor、canonical engine、消费方
> selector 与纵向模块均已落地；只保留有明确发布窗口的私有持久化迁移读取。

## 当前结论

Agent 基建已经完成最危险的数据所有权迁移：Session、Turn、Interaction、
queue、pending intent、activation、cancel、error 与 reconcile 由 workspace
`AgentSessionEngine` 持有。Claude Code、Codex、OpenCode 以及其余注册 provider
都通过同一份 descriptor/strategy/capability seam 接入；Claude Code 只走 SDK
sidecar，Codex 走专属协议，OpenCode 走标准 ACP，但 GUI 不再按这三种传输形态
选择业务行为。

`useAgentGUINodeController.ts` 在本轮从 2,034 行降到 715 行，conversation-list
projection、UI-local/deletion state、engine sync、operations 和 view assembly 均由
独立纵向 hook 持有。controller 已低于 800 行硬限制，只保留模块装配。degradation
终值基线已锁定；切片 7 只剩客户端覆盖窗口结束后删除私有 migration reader，
该 reader 不属于公共契约、运行时 owner 或新写路径。

## 已完成

- OpenAPI v2、durable Turn/Interaction、exact-turn cancel、operation outbox 和
  canonical session normalization 已落地。
- engine 是 session/turn/interaction/queue/pending/error/reconcile 的生产 owner；
  activation hook 只 dispatch engine intents，不再直调 runtime 并维护 React 状态机。
- submit/queue optimistic overlay、conversation-list submit-pending 双轨、旧 queued
  prompt coordinator 与旧 overlay 符号已删除。
- `AgentGUINodeProps` 与 `AgentGUINodeViewModel` 已按语义职责分组；真实
  view-model hook、垂直模块边界和 render-budget contract tests 已落地。
- `AgentComposer.tsx` 为 597 行，`AgentGUINodeView.tsx` 为 783 行；旧 2,000+
  行 conversation-list store 已退役。
- `AgentHostWorkspaceAgentSession`、`AgentHostWorkspaceAgentMessage`、
  `AgentHostWorkspaceAgentTimeline*` 的生产镜像扫描为零。旧 session write methods
  已从 AgentHost seam 删除。
- provider 行为分支扫描在 Agent GUI 和 desktop workspace-agent 生产代码中为零；
  managed provider 集合、启动探测顺序、可见性、安装 bootstrap、账号刷新与 runtime
  probe fallback 均来自 daemon descriptor 生成的 desktop strategy catalog。
- persisted `providerTargetId` 只在私有 workbench/launch migration reader 中读取并
  立即提升为 `agentTargetId`；新状态与 launch payload 只写 `agentTargetId`。

## 延后清理

当前审计未发现 Agent 基建 P0。非诊断消费方不再直读 `snapshot.sessions`；Host
Session/activation/pin DTO、`providerTargetRef`、desktop canonical-to-Host session
投影和合成 `session_update` 均已删除；activation settings/result 使用 core typed
contract；`service_helpers.go` 已按 Codex status 职责拆到 769 行。

切片 7 仍有一个按发布窗口执行的清理项：workbench 的 `providerTargetId` 读取是 persisted-state
migration，必须保持私有、只读且不回写，并在客户端覆盖窗口结束后删除。
Agent 作用域生产文件扫描已无超过 800 行的业务文件；通用 image download 命名与
下载副作用也已从 `ZoomableImage.tsx` 拆为独立窄模块。

## Provider 接入状态

| Provider                    | Runtime seam         | Descriptor 状态                           |
| --------------------------- | -------------------- | ----------------------------------------- |
| Claude Code                 | SDK sidecar          | 已收口，不存在 ACP 注册                   |
| Codex                       | 专属 app-server 协议 | 已收口                                    |
| OpenCode                    | 标准 ACP             | 已收口                                    |
| Cursor                      | 标准 ACP             | 已收口                                    |
| Tutti Agent                 | 专属协议族           | 已收口                                    |
| Nexight / Hermes / OpenClaw | 标准 ACP             | 已收口；不可用项显式 disabled/unsupported |

传输协议不是 GUI seam。新增或修改 provider 行为必须经 daemon
ProviderDescriptor 和 typed strategy/capability/catalog，不得在 controller、composer
或 view 中新增 identity branch。

## 最近验证

本轮 controller 顶部切片验证：

- `@tutti-os/agent-gui` `tsgo --noEmit` 通过；
- scoped Oxlint 通过；
- `AgentGUINode.spec.tsx` 161/161 通过；
- 主 controller 从 2,034 行降到 715 行。

当前工作树验证：Agent GUI 129 files / 1,827 tests、Desktop 1,193 tests、
activity-core/GUI/desktop typecheck、provider strategy 与 activity-runtime boundary
checker、provider catalog 生成检查、provider registry/daemon/store/tuttid tests、
agentstatus tests/build、Go lint、desktop build 与 `git diff --check` 均通过。

## 下一步顺序

1. 完成持久化 migration 窗口后删除 `providerTargetId` 私有 reader 与其测试夹具。
2. 后续变更持续执行 architecture review 与 `pnpm check:full`，不得提高已锁定基线。

## 完成判定

只有以下条件全部成立才能关闭本重构：controller 不超过 800 行且只是薄装配层；
所有消费方通过 selectors 读取；兼容 seam 有明确删除或已删除；provider 行为只读
descriptor/capabilities/catalog；无 Agent 业务文件违反 800 行规则；durable docs 与
真实数据流一致；架构复审无 finding；`pnpm check:full` 通过。
