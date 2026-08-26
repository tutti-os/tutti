# Agent Runtime / Activity 可靠性改造方案

状态：Proposed
日期：2026-08-21
范围：`tutti` 单仓库；基于当前 `origin/main` 与 PR #2555 合并后的代码。
证据来源：飞书 bug 日志、当前代码调用链、已有回归测试；没有证据的结论明确标记为“待确认”。

## 1. 背景与目标

当前问题集中在三条边界：Provider/ACP 输出归一化、tuttid 持久化后的活动事件传播、桌面端 AgentGUI 投影。目标是让下一次执行得到正确结果或明确失败，而不是把错误隐藏、降级成成功，或只在 UI 层改文案。

### 1.1 已确认问题

| 问题                                                  | 直接原因                                                                                    | 系统性原因                                                                    | 结论可信度                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| 高密度 `message_delta` 触发 React #185 / 更新风暴     | 事件到达时同时驱动 canonical reconcile、乐观消息和 UI 通知                                  | 传输适配、状态投影、通知调度边界曾经耦合，没有统一的 workspace 级批处理入口   | 高                                      |
| MCP 普通输出被展示为 Error                            | `output` 与 `error` 没有在 Provider payload、daemon projection、GUI renderer 全链路保持分离 | 各层兼容了不同的 `isError`/`is_error`/`output` 形状，缺少统一状态与字段不变量 | 高                                      |
| ACP `isError` 或 `is_error` 未可靠映射为失败          | 终态主要由事件类型或普通输出推断，显式错误标志未优先参与判定                                | Provider 原始 payload 没有先归一化为统一的 `failed` 语义                      | 高                                      |
| Windows 缺少 cwd 时 ACP 使用了不适合 Windows 的根路径 | 空 cwd 的跨平台 fallback 没有按 OS 选择                                                     | 协议 cwd、进程 cwd、Provider 搜索 cwd 的责任没有被明确拆开                    | 高                                      |
| Windows Cursor Glob/Grep 绝对路径搜索失败             | 日志证明进入 Provider 边界的绝对路径搜索失败；内置 `rg.exe` 对同类有效路径本身可用          | Provider 内部路径转换/搜索参数形状未被 Tutti 完整观测                         | 边界结论高；Provider 内部具体函数待确认 |
| 会话尚未进入 canonical snapshot 时重命名失败或丢失    | UI action 直接写 session，没有等待 canonical session 出现                                   | 临时激活态与 canonical lifecycle 的 readiness 边界不明确                      | 高                                      |

### 1.2 目标

1. canonical store 是会话、turn、message 和 terminal status 的唯一事实来源。
2. Provider 的 status、input、output、error 在 daemon 边界一次归一化，并保留可诊断信息。
3. 活动事件只在持久化提交后对外发布；desktop/mobile 只负责传输适配，workspace coordinator 负责顺序、批处理、断点和重连。
4. Windows 的 process cwd、protocol cwd 和 Provider 搜索路径分别有明确契约；失败时返回真实失败原因。
5. 每个修复都有跨边界回归测试，能证明“正确结果”或“明确错误”，不以“页面不报错”为验收标准。

## 2. 当前架构和完整链路

### 2.1 运行时到 UI 的读取/事件链

```text
Provider process / ACP
  -> packages/agent/daemon/runtime
     (standard ACP adapter, tool normalizer, Reporter)
  -> services/tuttid/service/agent/ActivityProjection
  -> packages/agent/store-sqlite
     (canonical durable session/turn/message state)
  -> post-commit publisher / agent.activity.updated
  -> desktop WebSocket adapter 或 mobile DeviceLink adapter
  -> packages/agent/activity-core
     (workspace event coordinator, optimistic overlay, reconcile)
  -> AgentSessionEngine
  -> packages/agent/gui AgentGUIRuntime/selectors/projection
  -> React AgentGUI tool renderers
```

关键事实：

- `DurableActivityReporter` 把 runtime event 转成 `ReportActivityInput`；tuttid wiring 将其接到 `ActivityProjection`。
- `ActivityProjection` 先写 canonical repository，再通过 `ObserveCommitted` 做事件发布、daemon-local view 和 Provider cleanup。事件回调不是持久化成功的前置条件。
- `agent.activity.updated` 是 server-to-client 的活动主题；desktop 的 `WorkspaceAgentActivityReconcileBridge` 将事件交给 `createAgentActivityWorkspaceEventCoordinator`，而不是直接在组件中改状态。
- `AgentGUIRuntime` 使用 `AgentSessionEngine` snapshot 与订阅；GUI 组件不应直接读取 WebSocket 或 Provider 原始 payload。

### 2.2 GUI action 的写链

```text
AgentGUI semantic action
  -> AgentSessionEngine typed command
  -> apps/desktop WorkspaceAgentActivityService / Desktop adapter
  -> tuttid client / service / Host runtime boundary
  -> ActivityProjection -> canonical store
  -> post-commit event 或 session reconcile
  -> activity-core -> AgentSessionEngine
  -> GUI snapshot / selector
```

重命名的 readiness 修复位于 GUI controller：`waitForCanonicalSession` 等待 session 进入 engine 的 canonical snapshot 后，才调用 `renameSession`。这保持了写操作的 owner 仍为 engine，而不是在 UI 中新增第二份 session 状态。

### 2.3 Windows Provider 链

```text
activation / service resolves cwd
  -> standard ACP ProcessSpec.CWD + ProtocolCWD
  -> ACP session/new 或 resume
  -> Provider Glob/Grep 或 native rg / PowerShell
  -> normalized call status/input/output/error
  -> Reporter -> canonical store -> event -> activity-core -> GUI
```

当前代码已经在 `standardACPProtocolCWD` 对空 cwd 做 Windows/POSIX 分支，并在 process start 日志同时记录 `cwd` 与 `protocol_cwd`。Cursor runtime preparation 还会注入 Windows 搜索策略：workspace 内使用相对路径，workspace 外或不确定时使用 native terminal 搜索。

### 2.4 直接原因与系统性原因

直接原因是一次请求或一次渲染中使用了错误的字段、路径、终态或 readiness；系统性原因是同一个事实在 Provider、daemon、transport、activity-core、engine、renderer 多层重复解释。改造重点是收窄解释边界，而不是增加更多兼容分支。

## 3. 目标架构和完整链路

### 3.1 目标链路

```text
Provider / ACP raw event
  -> runtime adapter: 归一化 status + input/output/error + cwd
  -> DurableActivityReporter
  -> ActivityProjection: 事务内写 canonical store
  -> committed activity envelope: 只发布已提交事实
  -> transport adapter: WebSocket / DeviceLink，仅处理连接和反序列化
  -> activity-core workspace coordinator:
       顺序校验、批处理通知、乐观 overlay、gap/reconnect reconcile
  -> AgentSessionEngine: 唯一前端生命周期状态
  -> AgentGUIRuntime / selector / projection
  -> renderer: 按 status 与 output/error 分区展示
```

### 3.2 目标不变量

- `failed` 只能来自 Provider 显式错误、`call.failed`/等价失败事件、明确的非零退出或归一化后的错误；普通 output 不能单独制造 Error 区域。
- `output` 是成功或失败调用的结果内容，`error` 是失败原因；失败时两者都可以存在，但不能互换或互相覆盖。
- canonical 写入先于对外活动事件；事件丢失、乱序、跨 session 或版本不合法时，触发 reconcile，不直接污染本地状态。
- workspace 级通知由 coordinator 的注入 scheduler 批处理；desktop 不再为同一事实新增第二个 renderer timer。
- 已提供 cwd 必须原样传递；Windows 空 cwd 使用当前进程的有效工作目录；workspace 内搜索优先相对路径，workspace 外搜索使用 Provider 已验证的 native 搜索入口。
- 不能确认 Provider 内部路径转换时，必须保留原始错误和诊断字段，并标记为 Provider 边界待确认，不能返回“搜索成功”。

### 3.3 Cursor 问题的边界

已能确认 Tutti 侧的两个防线：Windows 空 cwd 不再使用错误的 POSIX fallback；Cursor preparation 会给 Provider 明确的相对路径/native terminal 搜索策略。但现有日志没有原始 ACP tool request/response，且真实 Provider 复现曾受 quota 限制，因此“Cursor 内部将 `C:/...` 转换为空路径的具体实现位置”仍待确认。完整修复必须补齐该证据或与 Provider 维护方确认，不能仅凭 Tutti 侧 prompt policy 宣称已解决。

## 4. 仓库、服务和模块改造范围

当前证据只覆盖 `tutti` 这一仓库；未确认需要修改其他仓库。

| 范围                                                     | 改造内容                                                                                                                                            | 不应承担的职责                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/agent/daemon/runtime`                          | 维护 ACP session cwd/protocol cwd；统一 `isError`/`is_error`、event type、退出状态、input/output/error 归一化；记录可脱敏的 process/tool 诊断       | 不做 GUI 文案、React 状态或桌面连接管理                       |
| `packages/agent/runtimeprep`                             | 维护 Cursor Windows session-scoped 搜索上下文和相对路径/native terminal fallback；补充可验证的 preparation contract                                 | 不在这里判断 Provider 返回是否成功，不复制 daemon status 逻辑 |
| `packages/agent/daemon/activity`                         | 将 normalized call 生成 `WorkspaceAgentMessageUpdate`，保持 status、input、output、error 字段分离                                                   | 不读取 renderer 状态，不为每个 Provider 写 UI 分支            |
| `services/tuttid/service/agent`                          | 保持 `ActivityProjection` 作为 durable commit owner；统一 post-commit fanout 和 scope 校验；异常事件只请求 reconcile                                | 不把事件回调当作持久化成功条件，不创建第二个 canonical store  |
| `services/tuttid/agent_runtime_activity_event_bridge.go` | 校验 runtime event scope、过滤 malformed/cross-scope event、限流 reconcile request，并保留可诊断日志                                                | 不在 event bridge 中修正业务状态或吞掉 Provider 错误          |
| `packages/agent/store-sqlite`                            | 当前不改 schema；继续作为 canonical durable repository                                                                                              | 不保存一份仅供 UI 使用的平行状态                              |
| `packages/agent/activity-core`                           | 复用 workspace coordinator、optimistic overlay、gap/reconnect reconcile 和注入 scheduler；必要时补充 contract tests                                 | 不依赖 WebSocket、Electron、DeviceLink 或 Provider 类型       |
| `apps/desktop`                                           | WebSocket 生命周期、诊断、连接状态和 `WorkspaceAgentActivityReconcileBridge` 适配；所有状态变更经 engine/coordinator；保留 canonical readiness 等待 | 不新增桌面侧业务 coordinator、第二套定时器或 Provider 解析器  |
| `apps/mobile`                                            | 只把 DeviceLink delivery 归一化后交给同一个 activity-core contract；补充移动端连接/重连适配测试                                                     | 不复制 desktop 的事件顺序、overlay、reconcile 算法            |
| `packages/agent/gui`                                     | 使用统一 status/output/error render data；GUI action 通过 `AgentGUIRuntime`/engine；structured fallback 有深度和长度上限                            | 不直接解析 ACP 原始事件，不把异常改成普通 output              |
| `packages/agent/host`                                    | 当前无需改生命周期语义；若后续发现 session/turn lifecycle contract 缺能力，先增加 Host conformance scenario，再由 Host 提供 API                     | 不在 tuttid 或 desktop adapter 中重新实现 lifecycle owner     |
| `services/tuttid/api/openapi` 与 clients                 | 当前不计划改公共 HTTP contract；若确需新增 envelope 字段，先改 OpenAPI，再生成/更新 client，并保持字段可选                                          | 不以未确认的日志字段直接扩展公共 API                          |
| `docs/architecture` / `docs/conventions/troubleshooting` | 仅在行为或边界发生新增时更新对应持久文档；本方案本身是实施入口                                                                                      | 不复制代码注释或堆叠重复排障说明                              |

## 5. 可复用部分与 Adapter 边界

| 可复用核心                                       | Adapter 输入/输出                                                               | 边界规则                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `store-sqlite` canonical repository              | 接收已校验的 projection command，返回 committed result                          | 只拥有 durable truth，不感知 Provider/UI                                              |
| `ActivityProjection` + `DurableActivityReporter` | runtime normalized event -> canonical update                                    | 归一化在 runtime；事务提交与 fanout 在 service；不把 provider raw payload 向上泄漏    |
| `activity-core` workspace coordinator + overlay  | transport delivery -> normalized activity event；输出 snapshot/reconcile intent | 同一实现服务 desktop/mobile；只注入 scheduler、snapshot reader 和 dispatch capability |
| `AgentSessionEngine` + `AgentGUIRuntime`         | service/adapter command port -> typed engine state                              | engine 负责前端 session lifecycle；组件只消费 snapshot/selector                       |
| ACP tool/status normalizer                       | Provider raw event -> stable status/input/output/error                          | Provider 特殊字段只在此处或其窄 adapter 解释，不能进入 GUI/shared generic model       |
| OS/process path adapter                          | logical cwd -> process cwd/protocol cwd/native search command                   | Windows/POSIX 差异留在 runtimeprep/process adapter；产品核心保持 platform-neutral     |
| desktop WebSocket / mobile DeviceLink adapter    | transport payload + connection state -> activity-core input                     | 只负责连接、反序列化、诊断、analytics/presentation invalidation，不拥有业务顺序算法   |

禁止为上述边界再创建含义不清的 `shared/common/utils` 包或第二个 event center；只有出现真实的第二个消费者和稳定窄接口时才抽取新 package。

## 6. 明确不做的内容

- 不重写 AgentGUI、ACP runtime、SQLite 或整个 event stream。
- 不通过捕获异常、默认成功、清空错误字段或只改 UI 文案来“修复”问题。
- 不在当前证据不足时声称已经完成 Cursor Provider 内部绝对路径转换修复；真实 Provider request/response 和配额可用性属于待确认项。
- 不新增数据库 schema、历史数据回填或删除已有 activity；没有证据证明历史记录可安全重算。
- 不新增公共 API 字段；除非确认跨进程消费者需要，并按 OpenAPI-first 流程走兼容变更。
- 不扩大到 dormant background-task guard、未关联本调用链的 bug 表项目或其他仓库问题。
- 不把 desktop/mobile 各自实现成一套活动状态机，也不把 Provider 分支写进 `activity-core` 或 GUI。

## 7. 数据迁移和兼容策略

### 7.1 当前方案

当前改造不改变 SQLite schema、canonical record 语义或 `agent.activity.updated` 的必需字段，因此不需要数据迁移。已有 session 在下一次 start/resume 时使用新的 cwd 规则；历史已经写入的错误 status 不自动回写，因为缺少足够证据判断其真实 Provider 结果。

### 7.2 读取兼容

- 归一化同时读取 `isError` 与 `is_error`、旧 event type 别名和缺失的 output/error 字段。
- 旧记录缺少 `error` 时仍可展示已有 output；未知结构只做有上限的文本提取，不改变 terminal status。
- 新增字段只能采用 optional/additive 方式；旧 desktop/mobile 客户端忽略未知字段仍应能完成基本 reconcile。
- 若公共事件 envelope 需要版本变化，先更新 OpenAPI/事件 catalog 和 consumer contract，再同时保留旧字段一段兼容窗口；当前没有证据表明需要升版本。
- Cursor preparation 是 session-scoped；是否能在不重启 live session 的情况下重新注入上下文待确认。若不能，则只对新建或重新准备的 session 生效，并在诊断中明确这一点。

## 8. 风险与回滚方案

| 风险                                   | 影响                          | 控制/验证                                                                 | 回滚                                                                       |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Provider payload 仍有未覆盖形状        | status 或 error 展示不一致    | 保留 raw-safe summary，增加 normalizer fixture 和未知字段日志             | 回退归一化提交；canonical schema 不变                                      |
| 严格失败判定暴露更多真实失败           | 用户看到失败数上升            | 对照 Provider 原始事件和退出状态，不以 UI 无红色为指标                    | 回退代码提交，不修改历史数据                                               |
| coordinator 批处理造成短暂显示延迟     | UI 反馈变慢                   | 测量通知次数、reconcile 延迟和最终一致性；使用现有注入 scheduler          | 回退 coordinator 变更，transport contract 不变                             |
| Windows cwd 仍在某个 Provider 内被重写 | 搜索继续失败                  | 采集脱敏的 `cwd/protocol_cwd/tool input/output`，补真实 Provider ACP 测试 | 暂停 Cursor policy 变更，保留 native terminal fallback；等待 Provider 证据 |
| event scope/version 不兼容             | 客户端触发 reconcile 或丢更新 | malformed/cross-scope fixture、旧 payload contract test                   | 回退 event bridge/consumer commit，不清理 canonical 数据                   |

首选回滚粒度是回退对应代码提交并重新部署，不做 destructive 数据操作；因为本方案不含 schema migration，回滚不需要 down migration。

## 9. 测试与验收标准

### 9.1 单元与契约测试

- `packages/agent/activity-core`：高密度 delta 的批处理、乱序/gap、跨 scope、重连 hydration、optimistic overlay terminal truth；保留现有 `511/511` 基线。
- `packages/agent/daemon/runtime`：Windows/POSIX 空 cwd、显式 `isError`/`is_error`、`call.failed`、非零退出、output/error 同时存在、未知 payload。
- `packages/agent/daemon/activity` 与 `services/tuttid/service/agent`：normalized call 到 canonical projection 的 status/input/output/error 映射，以及“提交后才发布”。
- `packages/agent/runtimeprep`：Cursor Windows prompt/context 使用相对路径和 native fallback；session-scoped cleanup。
- `packages/agent/gui`：普通 MCP output 不出现 Error 区域；失败调用显示真实 error；失败调用仍可显示 output；tool sequence 保持顺序；structured fallback 受深度/长度限制。
- `apps/desktop`：canonical session 尚未出现时 rename 等待；WebSocket connection state 与 coordinator 生命周期正确 dispose。

### 9.2 集成与 Windows 验收

1. 从 runtime event 开始，验证 `runtime -> ActivityProjection -> SQLite -> committed event -> desktop/mobile adapter -> activity-core -> engine -> GUI` 的端到端结果。
2. 注入连续 `message_delta`，确认通知被 workspace coordinator 合并，最终 canonical message 完整，且不产生 React #185 类重复更新风暴。
3. 注入 malformed、cross-session、gap event，确认不直接写入错误 session，而是产生受限 reconcile 请求。
4. Windows 分别验证：已提供 cwd、空 cwd、workspace 内相对搜索、workspace 外绝对路径 native 搜索；结果必须正确，失败必须带可行动错误。
5. 在真实 Cursor Provider 配额可用后，采集原始 ACP tool request/response，再验证绝对路径失败是否已由 Provider 修复；在此之前该项验收状态为“待确认”，不能标记完成。

### 9.3 验收口径

- 正确返回：canonical 数据、活动事件、engine snapshot 和 UI 展示的 status/output/error 一致。
- 正确失败：失败原因可从日志或 UI 定位，不能被转换为成功或静默丢弃。
- 兼容：旧 payload 和已有 session 可读取；不要求历史错误记录自动重算。
- 架构：没有新增第二个 canonical owner、第二套 workspace event coordinator 或 Provider 逻辑进入 GUI/activity-core。
- 当前基线已验证：activity-core 测试通过；ACP/runtimeprep/desktop 相关聚焦测试通过。部分更宽的 Windows symlink 测试受本机权限限制，需在具备权限的 Windows CI/环境补齐，不将权限失败误判为产品修复证据。

## 10. 分阶段实施顺序

### 阶段 0：证据和契约冻结

补齐 Cursor 原始 ACP request/response、真实 Provider 配额复现、live session 是否支持重新 preparation 三项证据；同时冻结 status/output/error、cwd、commit-before-publish 和 reconcile contract。未补齐的项保持“待确认”。

### 阶段 1：落地已确认的窄边界修复

以 PR #2555 当前代码为基线，完成并保持：runtime status/error 归一化、Windows ProtocolCWD fallback、Cursor Windows preparation policy、activity-core 批处理/overlay、GUI output/error 分区、canonical session readiness。每项都补上对应单元/契约测试。PR #2555 已包含其中一部分，不应重复实现。

### 阶段 2：跨层集成和 Windows gate

验证 `ActivityProjection -> committed event -> adapter -> coordinator -> engine` 全链路；加入高密度、gap、跨 scope、重连场景；在 Windows CI 或具备权限的环境验证 process cwd、native search 和真实 Provider tool call。

### 阶段 3：小范围发布与观察

观察失败分类、reconcile 频率、事件延迟、重复通知和 Windows 搜索成功率。若出现回归，按提交粒度回退；不通过修改历史 canonical 数据掩盖问题。只有真实 Provider 证据确认后，才决定是否需要 Provider 侧变更或新增兼容字段。

### 阶段 4：文档收敛

将已验证的边界写入对应 architecture/troubleshooting 文档，删除重复的临时说明；对仍未确认的 Provider 内部结论保留明确的待确认状态，直到有原始协议证据。
