# Agent GUI / Windows 问题技术改造方案

状态：Proposed
日期：2026-08-14
范围：`tutti` 单仓库，覆盖此前已分析的 Agent GUI、ACP 和 Windows 问题。当前文档只定义改造方案，不包含业务代码修改。

## 1. 背景与目标

此前日志、代码、截图和 `make dev-gui` 启动验证暴露出一组相互放大的问题：Renderer 仍持有旧 session/turn/interactive 请求，daemon/runtime 同时接收新旧事件；provider 的异步事件和能力声明不完整；Windows 本地搜索及状态目录并发不稳定；部分 UI 只消费缓存或临时状态。

本方案的目标是：

1. 以 `(workspaceId, agentSessionId, turnId, requestId)` 作为跨层身份边界，旧请求不得改变当前会话状态。
2. 以 daemon 的 canonical session/turn/interaction 状态作为唯一状态源，Renderer 只做带身份的投影和恢复。
3. 将 provider 异步事件、能力和错误转换为统一的 Tutti 语义，并保留可诊断的安全错误信息。
4. 让模型切换、取消、关闭、重启、多窗口和高并发 handoff 具备幂等、可恢复的终态。
5. 修复 Windows 搜索、SQLite 状态目录竞争和窗口布局/缓存问题，同时保持现有 API 和已存在会话兼容。

### 已确认与待确认边界

已确认的证据包括：

- GPT-5.2 报告中，当前 session `80db00c1...` 的 `turn.start.succeeded` 和 `api.send.completed` 成功；失败请求却发往旧 session `70c13030...`。同一时间 `tuttid` 反复记录 `message_delta stream identity does not match its runtime scope`。
- Claude 高并发 handoff 中存在 5 秒终态 barrier 超时、workspace/agent target 查询超时，以及 provider 已不再认为 turn active 后的取消竞态。
- Cursor 声明 Plan mode，但缺少可用的 AskQuestion 能力；Kimi 的 permission 事件可能先于 tool input 到达。
- Windows Search 请求只带 `include_kinds=[file]`，provider 又排除了 Directory；搜索超时后 Renderer 收到 `AbortError/502`。
- Microsoft Store 版本确实启动了 AppX 内的 `tuttid.exe`，Agent 创建失败的日志根因是 `database is locked`；AppX Start 菜单注册和 manifest 图标文件均有证据存在。
- 新窗口可以看到新会话，旧窗口仍使用 rail projection/cache；取消问题缺少对应日志包。

以下结论在实施前必须通过复现或补充日志确认，不能作为本方案的隐含前提：

- GPT-5.2 失败 turn 的 provider 原始错误是网络、模型拒绝、权限、服务端错误还是进程退出；导出包没有保留该 error notification 的完整 payload。
- `message_delta` identity mismatch 是否直接导致该次“发送失败”，还是只造成流式内容丢失/旧状态投影。
- 原始问题清单中的第 11 项未在本次材料中提供独立症状和证据；在补充前不新增实现范围。
- 取消问题（下文问题 I）是终态事件丢失、Renderer 关联错误，还是 provider 取消延迟；当前只能依据代码提出防护。
- “Microsoft Store 是否需要桌面快捷方式”是产品要求还是误报；现有证据只证明 Start 菜单和 AppX 图标资源存在。

证据包（不提交到仓库）：`C:\Work\logger-analysis-gpt52\extracted-20260814\logs\tutti-desktop.log`、`tuttid.log`。对应生产版本为 `0.2.23-rc.8`，日志窗口为 2026-08-13 14:15:25–14:25:25（+08:00）。

## 2. 当前架构与完整链路

### 2.1 普通发送和 GPT-5.2 场景

```text
Renderer Agent GUI
  -> desktopAgentActivityAdapter.sendInput
  -> POST /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/input
  -> tuttid API SendWorkspaceAgentSessionInput
  -> service/agent.SendInput
  -> host.ApplicationHost().SendInput
  -> daemon runtime controller
  -> CodexAppServerAdapter.execBlocking
  -> app-server turn/start
  -> provider notifications
  -> reducer/turn machine/normalizer
  -> activity events + SQLite projection
  -> tuttid session query
  -> Renderer session/presentation/cache
```

当前代码证据：

- `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts` 负责 HTTP 发送和结果转换。
- `services/tuttid/api/daemon_agent_submit_handlers.go` 的 `SendWorkspaceAgentSessionInput` 记录 `api.send.received/completed`。
- `services/tuttid/service/agent/service_send_input.go` 负责 prompt 规范化、submit 幂等标识、Host dispatch 和 turn 刷新。
- `packages/agent/daemon/runtime/codex_appserver_turn.go:571-575` 记录并调用 `turn/start`；`turn/start` 成功后，后续 provider `error` 才会通过 turn machine 进入 failed。
- `packages/agent/daemon/runtime/codex_appserver_turn_machine.go:81-85,212-220` 将 provider error 转成普通 `error`；当前没有保证原始 code、provider turn 和安全用户消息均可追踪到日志/前端。

这说明 GPT-5.2 报告中的“请求失败”不能直接归因于 HTTP submit 或模型切换 API。已确认的直接错误表现是：旧 interactive response/旧 session 身份进入当前 Renderer 流程，当前新 session 的 turn 已被接受；实际 provider 失败原因仍待补齐原始 error payload。

### 2.2 Interactive、审批、AskUser 和取消链路

```text
provider permission / ask-user notification
  -> runtime pending interaction
  -> canonical pending interaction + activity projection
  -> Renderer pending UI
  -> POST .../interactives/{requestID}/response
  -> tuttid SubmitInteractive
  -> runtime SubmitInteractive / provider response
  -> provider continuation
  -> turn terminal event
  -> canonical state -> Renderer
```

入口为 `services/tuttid/api/routes_workspace_agent_sessions.go:253`，服务接口为 `SubmitInteractive`。问题在于当前 response 主要按 request/session 处理，Renderer 仍可能携带已经切换前的 session 或 turn；projection bridge 发现 mismatch 后只记录 warning，未立即重建 canonical state。

取消和窗口关闭另有一条链：

```text
Renderer stop / window close
  -> session engine stopRequested
  -> cancel API
  -> provider cancel + local context cancel
  -> turn settled event
  -> canonical activity projection
  -> composer busy/loading state cleared
```

`cancel_requested` 只是“取消已接受”，不是终态。窗口关闭则额外受到 `workspaceWindowCloseGuard.ts` 和 `workspaceWindow.ts` 中 guard 条件的影响；启动恢复时 Renderer 可能先恢复旧 pending interaction，再等待 daemon reconcile。

### 2.3 子 Agent handoff 链路

```text
root turn
  -> handoff/delegated task creation
  -> child agent session/provider turn
  -> child terminal report
  -> controller_report_worker barrier
  -> workspace/agent-target state query
  -> root cancellation or continuation
```

当前固定 5 秒终态 barrier、子会话枚举、provider cancel 和终态持久化不是一个原子操作。根会话取消时，provider 可能已经清除 active turn，导致 `agent cancellation target is no longer active`，而子会话的最终状态尚未可见。

### 2.4 Windows 文件引用和状态目录链路

```text
ReferencePicker
  -> filtersUseSearch / includeKinds
  -> workspace file API
  -> Windows Search OleDB
  -> PowerShell child process
  -> file/dir result
  -> Renderer picker
```

`services/tuttid/data/workspace/local_files_search_windows.go:117` 使用 `System.ItemType <> 'Directory'`；`workspaceFileLocationReferenceSources.ts` 将相关 source 标为 `filtersUseSearch=true`。搜索超时会沿 API 转成 502，Renderer 只得到通用失败。

Store/Direct 启动链路为：

```text
AppX/Direct desktop
  -> tuttid.exe
  -> shared .tutti state directory
  -> SQLite transaction
  -> upsert workspace agent session
```

SQLite 目前只配置有限 busy timeout（`services/tuttid/data/workspace/sqlite_store.go:156`），无法区分旧 daemon 未退出、两个实例并发，还是同一 daemon 内的长事务。

## 3. 目标架构与完整链路

目标不是引入新的 Agent 状态系统，而是在现有 canonical session/turn/activity 之上补齐四个不变量：

1. **身份不变量**：每个 command、provider event、projection event 都携带 workspace、agent session、turn；interactive 额外携带 request ID。身份不匹配的事件不能写入另一条 session。
2. **终态不变量**：取消、失败、完成只能由 canonical runtime 产生一次；重试、重启和重复 response 只做幂等 reconcile。
3. **配置不变量**：session canonical settings、runtime effective settings、provider `turn/start` settings 必须可追踪；模型切换只影响尚未开始的下一 turn，不能改变已运行 turn。
4. **恢复不变量**：projection mismatch、超时、窗口重开或 daemon 重启都触发 canonical reread/reconcile，而不是停留在临时 loading/pending 状态。

### 3.1 目标普通发送链路

```text
Renderer 创建 SubmitContext
  {workspaceId, agentSessionId, clientSubmitId, turnId?, requestId?, sessionRevision}
  -> API 校验 session/turn/request 身份及幂等性
  -> Service 在 canonical session lock 下准备一次 dispatch
  -> Runtime snapshot effective settings（包括 gpt-5.2）
  -> Provider adapter dispatch，记录 provider session/turn/model
  -> provider event 按身份路由
  -> terminal event 先持久化，再发布 projection
  -> Renderer 只接受同一 SubmitContext 的事件；否则丢弃并 reconcile
```

HTTP 仍可保持现有成功响应；stale interactive response 使用明确的 `409/410` 语义和机器可读错误码，不再包装成无差别 502。普通 provider failure 返回/投影 `failureCode`、安全 `userMessage`、`retryable` 和关联 IDs。

### 3.2 目标模型切换链路

```text
Renderer settings patch(gpt-5.2)
  -> API/service session settings lock
  -> Host canonical settings update
  -> Runtime adapter 更新“下一 turn effective settings”
  -> 不重建 live session，不取消当前 turn
  -> 下一次 turn/start 使用该 snapshot 的 model/effort
  -> model catalog refresh 作为 single-flight、可超时的旁路任务
```

模型目录刷新失败不得把已经可用的 live session 或正在运行的 turn 标记为 failed。provider 原始错误只有在安全抽取后才进入活动事件和日志；不能为了显示错误而记录 token、完整 prompt 或凭据。

### 3.3 目标交互、取消和恢复链路

- Interactive response 先在 service 层校验完整 tuple；canonical pending 不属于当前 tuple 时返回 stale，清理本地 pending projection，但不得取消当前 session 的新 turn。
- identity mismatch 触发一次按 session/turn 的 canonical reread；reconcile 结果以 revision/cursor 单调更新，避免旧 snapshot 覆盖新状态。
- cancel 先冻结新的 child task/新 response，再以 provider-specific cancel adapter 取消 provider turn，最后提交本地 terminal；目标已结束时返回最终状态而非错误。
- close guard、菜单、快捷键和原生窗口事件统一调用同一个 bounded close flow；启动先恢复 canonical state，再决定是否显示 pending interaction。
- child task 以持久化 task tree + durable terminal outbox 表达；barrier 只是等待优化，不是终态正确性的唯一保障。

### 3.4 目标 Windows 链路

- 文件浏览、目录搜索和全文搜索分离；UI 的 `includeKinds` 与后端查询保持一致，目录不能被强制过滤为 file。
- Windows 搜索使用可取消、分阶段返回的 provider；索引不可用或超时后进入目录缓存/枚举 fallback，并显示可操作的状态。
- Recent provider 是否纳入 Windows 由产品确认；若不纳入，UI 明确标注平台能力，而不是静默移除。
- state directory 增加单 daemon lease/handshake；新实例等待旧实例退出或复用已就绪 daemon。SQLite busy retry 采用有上限的退避并记录等待信息，持续冲突返回明确错误。
- AppX 图标与 Start 菜单保持现有 manifest；桌面 `.lnk` 只有在产品验收明确要求后另行设计。

## 4. 各模块改造内容

### 4.1 `apps/desktop`

- 在普通发送、interactive response、settings update、cancel 和 close flow 中统一构造/传递 `SubmitContext`；所有异步回调按 session/turn/request 比较后再写 UI。
- 旧 session response 只执行 stale 清理和 canonical refresh，不得覆盖 active session；将“当前发送失败”“旧交互已过期”“provider 失败”分成不同 UI 状态。
- `agentGui` 的 pending/busy 状态改为精确绑定 `(agentSessionId, turnId)`；`cancel_requested` 显示“正在停止”并等待 bounded reconcile，超时显示可重试而非无限 loading。
- 窗口关闭所有入口统一进入 close guard；重启恢复顺序改为 canonical session 先行。
- rail 在 session create/upsert 后广播 invalidate/upsert 给其他窗口；移除“active id 已加载就跳过刷新”的错误短路，保留分页和排序语义。
- 图片工具栏改用统一 titlebar safe-area CSS 变量；消除 fixed portal 与 native titlebar controls 的独立坐标。
- ReferencePicker 分离 browse/search/kind，补齐错误、取消、fallback 和 Recent 能力显示。

### 4.2 `services/tuttid/api` 与 `services/tuttid/service/agent`

- 统一校验 workspace/session/turn/request tuple 和 request revision；SubmitInteractive 对 stale、重复、目标已结束返回稳定机器码。
- 保留 `clientSubmitId` 幂等语义，补齐 command/dispatch/terminal 三段 trace，日志统一记录 provider session/turn、model、failure code 和耗时，不记录 prompt/token/credential。
- 把 provider failure 映射为结构化 `failureCode/userMessage/retryable`；仅在真正的 transport/API 失败时使用 502。
- 将 cancel、handoff、child task 的状态写入 canonical task/terminal outbox；重复 cancel 和 target 已结束必须幂等。
- 维护 settings lock 和 session revision，确保 settings patch、send、cancel 不以旧 snapshot 覆盖新状态。

### 4.3 `packages/agent/host` 与 `packages/agent/daemon/runtime`

- Host 继续作为 canonical/live settings 的协调边界；新增/复用 tuple 校验和按 revision 的 reconcile，不把 Renderer 临时状态下沉为事实。
- Codex adapter：模型/effort 作为 next-turn override；补齐 model catalog 已加载时 `configOptions`、session settings 和实际 `turn/start` 的一致性测试。不要因 catalog refresh timeout 重建 live client。
- model catalog refresh 使用 single-flight、超时和 stale-while-usable 结果；与 active turn dispatch 解耦。具体复用现有 app-server client 还是独立探测 client，需根据当前生命周期实现确认，不在方案中强行指定。
- turn machine 在 provider `error`、`turn/completed`、transport EOF、cancel 中统一生产一次 terminal，并输出安全结构化错误。
- `agent_runtime_activity_event_bridge.go` 发现 identity mismatch 时停止错误投影、发起 canonical reread，并带上 expected/actual scope；`controller_stream_observer.go` 不得继续把错误 scope 的事件发布给当前 session。
- ACP capability 增加 AskUser/Question 维度；Plan mode 的可用性由 `PlanMode && AskUser` 或明确 fallback 决定，不再只看 PlanMode。
- generic permission 与 ask-user 均按 `(providerSessionId, turnId, toolCallId/requestId)` 延迟合并；后到的 Read/ReadFile input 更新已有 pending interaction。
- handoff 使用 provider adapter 的 cancel/settle 能力，child 终态通过 outbox 重放；root cancel 前冻结 child creation。

### 4.4 `packages/agent/store-sqlite` / `services/tuttid/data/workspace`

- 若现有 activity payload 足以承载 `SubmitContext`，优先使用已有 JSON，不新增表；只有 task tree/outbox 没有可复用存储时才做加法 schema。
- 为 SQLite 写事务增加有限指数退避、数据库路径和等待时长诊断；通过 daemon lease 避免 Store/Direct 进程并行写同一状态目录。
- 搜索 provider 将目录/文件 kind 变成明确参数；Windows PowerShell 进程必须可取消并受总 deadline 约束，fallback 不阻塞 session runtime。

### 4.5 OpenAPI、TypeScript client、打包资源和文档

- API 若增加 stale/failure 字段，先更新 `services/tuttid/api/openapi/tuttid.v1.yaml`，再重新生成 Go/TypeScript client；旧客户端仍可读取原有 session/turn 字段。
- AppX manifest 和 logo 文件本轮只做安装验收，不因没有证据而改动；桌面快捷方式另立产品需求。
- 增补运行手册、故障码和 Windows E2E 复现步骤，避免后续只能依赖通用“请求失败”。

## 5. 可复用部分与 Adapter 边界

### 可复用的核心能力

- 现有 session/turn/activity canonical projection、session lock、`clientSubmitId`、turn normalizer、activity replay/cursor。
- 现有 `ApplicationHost`、provider registry、runtime context、OpenAPI 生成链路。
- 现有 close guard、rail query controller、SQLite store 和 Windows provider 的取消/测试基础设施。

### Adapter 边界

- **Provider adapter** 只负责 provider protocol：Codex `turn/start`/model catalog，Claude child turn，Cursor capability，Kimi permission event 顺序；不能自行修改 Renderer session 状态。
- **Runtime core** 负责身份、幂等、终态、reconcile 和安全错误模型；不能把某个 provider 的字段直接暴露为全局状态。
- **Desktop adapter** 只负责传输、投影和用户交互；不能根据“请求返回 200”推断 turn 已完成。
- **Windows adapter** 只负责搜索/状态目录/打包平台差异；不改变 Agent turn 状态机。

这样可以复用一个 Tutti 状态机，同时把 provider 的异步协议差异限制在适配器内，避免为 Codex、Claude、Cursor、Kimi 各自复制一套取消或 pending 逻辑。

## 6. 明确不做的内容

- 不在未拿到 provider 原始错误前，强制把 GPT-5.2 失败归因成“模型不可用”，也不自动降级到 GPT-5.5。
- 不重写整个 Agent GUI、ACP 客户端或 SQLite 层；只补身份、终态和必要的旁路能力。
- 不把所有 `message_delta` mismatch 都当作 provider failure；先修复错误 scope 投影并保留独立指标。
- 不把固定等待时间简单调大来掩盖 handoff barrier；终态必须可持久化、可重放。
- 不在没有产品确认时创建桌面快捷方式或替换 AppX logo。
- 不默认替换 Windows Search 为第三方索引服务；先实现正确 kind、取消、fallback 和明确能力声明。
- 不删除已有 session、pending interaction 或 SQLite 数据；迁移只允许加法和可回滚重放。

## 7. 数据迁移与兼容策略

- 现有 session/turn 数据继续可读；新增的 context、failure、task/outbox 字段全部可选，旧记录按“无 revision/无 error detail”兼容读取。
- 启动 reconcile 扫描旧的 running/pending 状态：若 provider 已结束则补 terminal；若无法确定则标记 `reconcile_required`，不伪造 completed。
- 旧客户端不发送完整 tuple 时，服务端只在 canonical pending 与当前 session/turn 唯一匹配时兼容处理；否则返回 stale，而不是猜测目标。
- task tree/outbox 若需要 schema，采用新表/新列和版本化 payload；发布顺序为“先读兼容，再写新字段，确认稳定后才可清理旧字段”。
- SQLite lease 不改变数据库内容；busy retry 和错误码为运行时兼容变更。
- rail/event 广播采用可丢失通知 + canonical reread，不能把跨窗口通知当作唯一数据存储。
- API 保持原有 200 成功响应字段；新增错误字段为 optional，旧 Renderer 仍显示通用错误，新 Renderer 显示结构化错误。

## 8. 风险与回滚

主要风险：

- tuple 校验过严导致合法的旧客户端或重启恢复请求被拒绝；需保留兼容分支并记录拒绝原因。
- provider event 延迟/乱序使 reconcile 产生重复 terminal；必须由 canonical revision 和 terminal 幂等键去重。
- catalog single-flight 或 Windows fallback 增加首次等待；需以 stale catalog/渐进结果保证可用性。
- SQLite lease 误判残留进程，造成无法启动；lease 必须带 PID、启动时间和可验证的 ready/exit handshake，不能只看文件存在。
- close flow 的 bounded wait 可能让用户提前看到“正在停止”；这是可接受的中间态，但必须有最终 reconcile 和重试入口。

回滚方案：

1. 按能力设置独立 feature flag：`identity_guard`、`terminal_reconcile`、`provider_error_detail`、`handoff_outbox`、`windows_search_fallback`、`cross_window_invalidation`、`titlebar_safe_area`。
2. 先关闭 UI 展示和旁路优化，再保留只读日志；API 新字段保持 optional，旧版本可以继续运行。
3. schema 只做向后兼容加法；若 outbox 写入异常，停止新写入并从 canonical activity 重建，不删除已有数据。
4. 发布后以 session/turn/request 维度监控 stale reject、duplicate terminal、identity mismatch、SQLite lock wait、搜索超时和 provider failure code；异常升高时按模块回退。

## 9. 测试与验收标准

### 9.1 自动化测试

- Runtime：模型目录已加载时切换 `gpt-5.5 -> gpt-5.2`，断言 canonical settings、runtime config、`turn/start` params 全部为 gpt-5.2；旧 active turn 不改变。
- Runtime：provider error、EOF、cancel、重复 terminal 各只产生一个 terminal；错误包含安全 `failureCode` 和 retryability。
- Projection：构造 expected/actual scope 不同的 `message_delta`，确认错误事件不污染目标 session，并能完成一次 canonical reread。
- Interactive：旧 request、重复 response、目标已结束、当前 request 分别验证 409/410、幂等成功和正常 provider response。
- Handoff：10–20 个 child turn 下取消 root、取消 child、取消后重启；所有 child 最终为 canceled/settled，outbox 可重放。
- Capability/ACP：provider matrix 覆盖 Plan-only、Plan+AskUser、generic permission-first、tool input-first 和 tool input-late。
- Windows search：file/Directory/未索引/取消/超时/fallback/Recent（Recent 是否支持待产品确认）。
- SQLite：两个 daemon、Store/Direct 交替启动、旧进程退出中启动；验证无不可恢复 `database is locked`。
- Desktop：窗口关闭三种入口、重启恢复、双窗口新建会话、DPI 100/125/150% 和窄窗口。

### 9.2 端到端验收

使用真实 Windows 环境通过 `make dev-gui`：

1. 打开两个 Agent session，把当前 session 从 GPT-5.5 切到 GPT-5.2；在旧 session 留下 pending approval，再向当前 session 发送消息。
2. 断言发送请求的 tuple 指向当前 session，`turn/start` 的 model 为 gpt-5.2；旧 response 被标记 stale 且不会使当前 composer 失败。
3. 在 provider 失败、网络不可达和模型目录超时场景，UI 显示结构化可操作错误；目录刷新超时不影响普通发送。
4. 并发启动/取消 10–20 个 child，关闭并重开应用；所有 session/turn/pending 状态最终与 canonical 状态一致。
5. 测试文件夹和未索引目录搜索，确认参数 kind 正确、超时有 fallback；双窗口新会话在事件周期内出现。
6. 验收截图/日志必须能用 `workspaceId + agentSessionId + turnId + requestId` 串起一次操作，且不出现错误 scope 的 `message_delta` 投影。

建议的性能门槛（基线需在实施阶段测量，数值未达标时标记待确认）：普通 send/settings API 的本地新增开销 p95 < 50ms；取消请求进入“正在停止” < 500ms；跨窗口 session upsert < 1s；搜索在 deadline 内返回结果或明确 fallback，不允许无限 spinner。

## 10. 分阶段实施顺序

### 阶段 0：补证据和冻结契约

- 用 `make dev-gui` 重现 GPT-5.2、旧 interactive、取消和双窗口场景，捕获完整 provider error notification。
- 确认原始第 11 项和取消问题的真实症状；确认 Recent、桌面快捷方式等产品决策。
- 先落地结构化 trace 字段和测试夹具，不改变用户行为。

### 阶段 1：身份、终态和恢复（P0）

- 实现 tuple 校验、stale interactive 语义、terminal 幂等和 projection mismatch reconcile。
- 修复 cancel/close/restart 的 canonical-first 流程；补 child cancel 冻结和最小 durable terminal outbox。
- 交付问题：GPT-5.2 旧请求串线、关闭后旧 AskUser、取消后无限 loading、Claude handoff 取消竞态。

### 阶段 2：provider 能力、模型与 ACP 事件（P0）

- 实现 AskUser capability matrix 和 Plan mode gating。
- 修复 Codex model settings/catalog single-flight、safe provider error；修复 generic permission 的 late tool input merge。
- 交付问题：Cursor Plan、Kimi Read/ReadFile 详情，以及 GPT-5.2 失败可诊断性。

### 阶段 3：Windows 数据链路（P1）

- 修复 file/directory search contract、取消/fallback/Recent 能力提示。
- 增加 state directory daemon lease、SQLite bounded retry 和明确错误码；完成 Store/Direct 交替启动验收。
- 交付问题：工作区引用搜索/文件夹、Microsoft Store Agent 启动。

### 阶段 4：桌面投影和视觉回归（P1）

- 完成跨窗口 rail invalidation、分页/排序回归。
- 完成 titlebar safe-area 和 DPI/窄窗口验收。
- 交付问题：旧窗口会话列表不刷新、图片工具栏与标题栏重叠。

### 阶段 5：灰度、观测和收口

- 按 feature flag 灰度，比较各阶段前后的 stale reject、identity mismatch、terminal latency、provider failure、SQLite lock 和 search timeout。
- 关闭不再需要的临时兼容分支前，确认旧客户端、重启恢复和已有数据均可读。
