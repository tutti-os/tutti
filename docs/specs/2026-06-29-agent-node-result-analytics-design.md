# Agent 节点成败埋点 — 设计文档

日期: 2026-06-29
范围: `apps/desktop`、`services/tuttid`、agent analytics reporters

## 背景

Agent 从环境准备到真正执行会跨过多层边界：

```text
Renderer / AgentGUI
  -> tuttid API / client
  -> tuttid service
  -> provider runtime
  -> ActivityProjection
  -> agent.activity.updated
  -> AgentGUI
```

现有埋点覆盖了部分业务漏斗事件，例如：

- `agent.env_detected`
- `agent.provider_login_initiated`
- `agent.provider_login_result`
- `agent.provider_ready`
- `agent.chat_ready`
- `agent.session_started`
- `agent.message_sent`
- `agent.message_stopped`
- `error.agent_session_failed`

这些事件不足以回答两个问题：

1. 每个关键步骤是否成功。
2. 失败时具体的 `error_code` 和 `error_message` 是什么。

尤其是 agent 执行过程中的 runtime 级失败，例如网络中断、provider 进程异常退出、
`RuntimeController.Start` / `Exec` 报错，目前可能只表现为 UI 状态、诊断日志或
session failed，不会稳定进入 DataFinder 产品埋点。

整体工作流图见：

- `/Users/chovy/Desktop/workspace/artifacts/agent-node-analytics-workflow.png`
- `/Users/chovy/Desktop/workspace/artifacts/agent-node-analytics-workflow.svg`

## 目标

1. Agent 相关埋点统一带 `error_code` 和 `error_message` 字段。
2. 每个关键节点都上报成功或失败。
3. 失败必须携带本地枚举化的 `error_code` 和可读的 `error_message`。
4. Agent 执行过程中的 runtime 级失败也要上报。
5. 工具调用失败不作为 agent runtime failure 上报。

## 非目标

- 不把 agent 任务内部失败当作运行时失败上报。
- 不为 shell/test/lint/tool call 的失败单独打 agent runtime 失败埋点。
- 不改变 provider runtime 行为、重试策略或 UI 状态模型。
- 不替换现有业务漏斗事件；现有事件继续保留。

## 事件模型

新增统一节点结果事件：

```text
agent.node_result
```

事件参数：

```ts
interface AgentNodeResultParams {
  flow: AgentAnalyticsFlow;
  node: AgentAnalyticsNode;
  status: "success" | "failure";
  provider: string;
  agentSessionId: string | null;
  durationMs: number | null;
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
}
```

上报到 DataFinder 时继续走现有 snake_case 归一化：

```json
{
  "flow": "message_send",
  "node": "runtime_exec",
  "status": "failure",
  "provider": "codex",
  "agent_session_id": "session-id",
  "duration_ms": 1234,
  "error_code": "agent_runtime_exec_failed",
  "error_message": "provider process exited unexpectedly"
}
```

成功事件也必须带错误字段：

```json
{
  "error_code": "agent_error_none",
  "error_message": ""
}
```

## 错误码枚举

本地定义 `AgentAnalyticsErrorCode`，所有 agent analytics reporter 必须使用枚举，
避免散落字符串。

初始枚举：

```ts
type AgentAnalyticsErrorCode =
  | "agent_error_none"
  | "agent_provider_status_failed"
  | "agent_install_failed"
  | "agent_install_timeout"
  | "agent_install_canceled"
  | "agent_install_probe_failed"
  | "agent_login_launch_failed"
  | "agent_login_timeout"
  | "agent_login_auth_failed"
  | "agent_session_create_failed"
  | "agent_session_resume_failed"
  | "agent_runtime_prepare_failed"
  | "agent_runtime_start_failed"
  | "agent_runtime_exec_failed"
  | "agent_runtime_network_disconnected"
  | "agent_runtime_process_exited"
  | "agent_runtime_canceled"
  | "agent_prompt_normalize_failed"
  | "agent_prompt_validate_failed"
  | "agent_prompt_prepare_failed"
  | "agent_activity_event_stream_failed"
  | "agent_activity_reconcile_failed"
  | "agent_unknown_error";
```

Go 侧保留同名常量，daemon 直接上报时使用同一批 code。

## 失败归因规则

Renderer 侧：

- 优先使用 `normalizeTuttidError(error)` 的 `code` / `reason`。
- 映射到本地 `AgentAnalyticsErrorCode`。
- `error_message` 使用技术错误信息，不使用只适合 UI 的翻译文案。
- 无结构化错误时 fallback：
  - `error_code: "agent_unknown_error"`
  - `error_message: error instanceof Error ? error.message : String(error)`

tuttid Go 侧：

- API/service 错误优先使用 `apierrors.Classify(err)`。
- runtime 错误先走已有 `normalizeRuntimeError(err)`。
- install action 结果使用 `RunActionResult.ReasonCode` 和 `Message`。
- 网络断开、进程退出等 runtime 异常需要映射到专门 code。
- 无法分类时 fallback 为 `agent_unknown_error`。

## 要覆盖的节点

### 安装 / 登录 / 准备状态

`flow = "provider_setup"`

节点：

- `provider_status_request`
- `provider_status_detect`
- `install_action_requested`
- `install_daemon_action`
- `install_cli`
- `install_adapter`
- `install_post_probe`
- `login_action_requested`
- `login_terminal_launch`
- `login_auth_poll`
- `login_ready_detected`

现有事件保留：

- `agent.env_detected`
- `agent.provider_login_initiated`
- `agent.provider_login_result`
- `agent.provider_ready`

需要补充：

- install 的 initiated/result 节点成败。
- provider status request 失败。
- login timeout / terminal launch failure 的统一 code/message。

### 新会话首条消息

`flow = "session_create"`

节点：

- `activate_session`
- `create_session_request`
- `content_normalized`
- `provider_runtime_checked`
- `model_validated`
- `cwd_resolved`
- `runtime_prepared`
- `runtime_started`
- `prompt_validated`
- `prompt_prepared`
- `runtime_exec`
- `session_started_reported`

现有事件保留：

- `agent.session_started`
- 首条 prompt 成功时的 `agent.message_sent`
- `error.agent_session_failed`

需要补充：

- create 中所有关键 service/runtime 节点的 success/failure。
- `error.agent_session_failed` 增加 `error_message`，成功类事件补空错误字段。

### 已有会话继续发送

`flow = "message_send"`

节点：

- `send_input_request`
- `runtime_session_ready`
- `content_normalized`
- `prompt_validated`
- `prompt_prepared`
- `runtime_exec`
- `session_refreshed`
- `message_sent_reported`

现有事件保留：

- `agent.message_sent`
- `agent.message_stopped`

需要补充：

- sendInput 抛错时必须上报失败。
- `RuntimeController.Exec` 失败必须上报失败。
- session refresh 失败必须上报失败。

### 执行过程和消息回流

`flow = "runtime_activity"`

节点：

- `runtime_event_received`
- `activity_projection_state`
- `activity_projection_messages`
- `activity_event_stream`
- `activity_reconcile_state`
- `activity_reconcile_messages`
- `agent_gui_refresh`

需要补充：

- event stream connect failed。
- `agent.activity.updated` reconcile failed。
- runtime 后续把 session 标为 failed 时，上报 runtime failure。
- 网络中断、进程异常退出等 runtime 级错误上报。

## Runtime 失败边界

需要上报：

- provider CLI / adapter 启动失败。
- provider 进程异常退出。
- runtime 网络中断。
- runtime start / exec 抛错。
- tuttid create/send API 失败。
- activity event stream 断开或 reconcile 失败。
- session runtime 状态进入 failed，并且失败来自 runtime/system 层。

不需要上报：

- agent 任务内部命令失败。
- 测试失败、lint 失败、构建失败。
- tool call 返回失败结果。
- 模型回答里描述某个任务失败。

判断原则：

如果失败代表“agent 基础设施不能继续正常运行”，上报。
如果失败只是“agent 正常运行后执行用户任务时得到失败结果”，不上报。

## 实现位置

Renderer：

- `apps/desktop/src/renderer/src/features/analytics/reporters/**`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/createDesktopAgentHostAgentSessionsApi.ts`

tuttid：

- `services/tuttid/service/reporter/events/agent/**`
- `services/tuttid/service/agentstatus/service.go`
- `services/tuttid/service/agentstatus/installer.go`
- `services/tuttid/service/agent/service.go`
- `services/tuttid/service/agent/activity_projection.go` 或实际 projection/reporting 边界

## 测试策略

Renderer：

- reporter completeness test 增加 `agent.node_result`。
- reporter type tests 确认 agent 事件都包含 `errorCode` / `errorMessage`。
- `DesktopAgentProviderStatusService` 覆盖 install/login success/failure。
- `createDesktopAgentActivityRuntime` 覆盖 activate/send success/failure。
- `WorkspaceAgentActivityService` 覆盖 reconcile failure。

Go：

- reporter events completeness test 增加 `agent.node_result`。
- agentstatus install action success/failure 测试断言上报参数。
- agent Service Create/SendInput 节点失败测试覆盖 code/message。
- runtime exec failure 测试覆盖 `agent_runtime_exec_failed`。

验证命令：

```sh
pnpm --filter @tutti-os/desktop test
pnpm --filter @tutti-os/desktop typecheck
pnpm test:go
pnpm check:changed
```

## 文档影响

需要更新：

- `docs/architecture/analytics-tracking.md`：新增 `agent.node_result`、错误字段约束和枚举规则。
- 如 agent runtime 失败边界有新增约定，补充到 `docs/architecture/agent-gui-node.md` 或 troubleshooting。
