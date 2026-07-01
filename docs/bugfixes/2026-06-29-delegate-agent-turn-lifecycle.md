# 2026-06-29 委托 Agent 后主会话误判为"停止"的根因分析

> Status: **analysis / proposed fix（尚未实施业务代码改动；关键外部行为已于 2026-06-30 实测确认，见下）**
>
> 本文记录"主 Agent 用后台 `Task`/`Agent` 工具委托子 Agent 后，主会话被误判为停止/已完成"的根因诊断与候选修复方案，供后续实现与评审参考。

## 问题描述（Bug）

1. 当主 Agent 委托一个 Agent 出去并"停止等待"之后，主 Agent 的会话状态会流转到"停止/已完成"，但被委托的 Agent 可能仍在运行。
2. 被委托 Agent 结束之后，会不会反过来通知主 Agent？

GUI 表现：工具调用卡片显示"委托 agent 已完成"，主会话回到空闲态，但实际子 Agent 仍可能在跑。

## 结论速览

- 截图里的"委托 agent"是 **Claude Code ACP 内置的 `Task`/`Agent` 工具**（不是 `tutti claude start` 这类独立会话）。`childSessionID` 仅从工具响应里取出**用于展示**，Tutti 对子 Agent 没有任何运行时建模。
- **根因**：Tutti 把一个 "turn" 严格绑定为一次 ACP `prompt` 调用。主 Agent 用后台 `Task` 工具把子 Agent 派出去后结束本轮（`stopReason=end_turn`），`prompt` 调用返回 → `finishTurn` → 会话状态从 `Working` 回落到 `Ready`（GUI 显示"已停止/空闲"）。但子 Agent 活在 `claude-agent-acp` 子进程内部，会比这次 `prompt` 调用活得更久，Tutti 这边却没有任何托管对象代表它。
- "委托 agent 已完成"这个标签是**工具调用本身的状态**（后台派发调用立即返回 completed），**不是子 Agent 真正跑完**。
- 第二问的答案是"**传输层能回传，但生命周期层不会真正通知/恢复主 Agent**"——详见下文。

## 证据链（file:line）

### 1. "委托 agent" = ACP 内置 Task/Agent 工具，childSessionID 仅用于展示

- `packages/agent/daemon/runtime/standard_acp_adapter.go:2865-2879`
  - 工具名为 `Agent`/`Task` 时，从 `toolResponse["agentId"]` 取出写入 `body["childSessionID"]`。这是**只写、单向**的，纯展示用。
- GUI 投影/展示：
  - `packages/agent/gui/shared/agentConversation/projection/agentTaskProjection.ts:54-59`（`delegateSessionId`）
  - `packages/agent/gui/shared/agentConversation/components/tool-renderers/AgentTaskContent.tsx`
  - 标签映射 `delegate_agent` → "委托 Agent"：`packages/agent/gui/shared/workspaceAgentToolCallLabels.ts:20,42,44`
- Tutti 的会话创建（`CreateSessionInput`/`RuntimeStartInput`）**没有任何 parentSessionId 字段**，`tutti claude/codex start` 也不接受父会话参数 → Tutti 层面根本不存在"父子会话"模型。子 Agent 完全活在 ACP 子进程内部。

### 2. 一个 turn == 一次 ACP prompt 调用，调用返回即结束本轮

- `packages/agent/daemon/runtime/standard_acp_adapter.go:788-967`
  - `Exec()` 阻塞在 `acpSession.client.Call(ctx, acpMethodPrompt, ...)`（857 行）。
  - 传入的消息回调**只在这次 Call 期间有效**（`emit != nil`）。
  - Call 返回时按 `stopReason` 收尾；默认 `end_turn` → `FinishCompleted` + `EventTurnCompleted`（状态 `SessionStatusReady`）（948-953 行）。
- `packages/agent/daemon/runtime/controller.go`
  - `Exec` → `beginTurn`（477）→ `go runExecTurn`（482）。
  - `runExecTurn` 跑完 `adapter.Exec()` 后调用 `finishTurn`（~593）。
  - `finishTurn`（645-657）从 `c.turns[key]` 删除该 turn，再 `reconcileSessionStatusLocked`（654）。
  - `reconcileSessionStatusLocked`（751-763）：只要 `c.turns[key]` 没有活跃 turn，就把 `Working` 回落为 `Ready`。
  - ⇒ 主 Agent 把子 Agent 派出去并结束发言后，本轮 `prompt` 返回 `end_turn`，状态必然回落到 `Ready`。这就是"流转到停止"的直接原因。

### 3. 后台子 Agent 的回传：传输层能收，生命周期层接不住

- 传输层**确实**有持久通道（不是只在 Call 期间监听）：
  - `packages/agent/daemon/runtime/acp_client.go` `readLoop`/`dispatchMessage`（~424-496）：无 id 的通知在没有活跃 Call 时落到**持久 handler** `c.handler`。
  - 持久 handler 在连接初始化时注册：`standard_acp_adapter.go:716-720` → `handleACPMessage(..., emit==nil)`。
  - out-of-turn 的 `session/update` → `handleACPMessage`（~1758-1858，`emit==nil` 分支 1801-1802）→ `emitSessionEvents`（1891-1902）→ controller 的 sink `applySessionEventsByAgentSessionID`。
- 但生命周期层**接不住**：
  - `controller.go:1605-1634` `applySessionEventsByAgentSessionID` 直接 `applySessionEvents` + `store` + `publish`，**完全不碰 `c.turns`**（不调用 `beginTurn`）。
  - 后果一：不会创建托管 turn → 没有 cancel func → **Stop/Cancel 无法作用于这段"复活"的活动**（与已知 stuck-spinner 现象同源）。
  - 后果二：状态是否回到 `Working` 完全取决于这股 out-of-turn 事件流里**是否带 `EventTurnStarted`**。`applySessionEvents`（441-443）用 `deriveSessionStatusFromEvents` 逐事件推导状态——若后台完成只回传工具/消息事件而没有 turn-started，状态推导返回空，会话**继续停留在 `Ready`/"已停止"**，GUI 不会重新变忙。
  - 后果三（最关键）：主 Agent 的**模型**是否真的会基于子 Agent 结果继续推理，取决于 `claude-agent-acp` 是否会在后台任务完成时**自动开新一轮**。而 **Tutti 只在用户 `SendInput` 时才发起 prompt 调用**（`Exec` → `beginTurn`）。Tutti 自己不会主动补一次 continuation prompt。所以如果 ACP 不自动续轮，主 Agent 在功能上**不会被"通知/唤醒"**——只会看到"委托 agent 已完成"然后会话闲置。

## 第二问的明确回答

"被委托 Agent 结束后会不会反过来通知主 Agent？"

- **传输/事件层**：能。late 的 `session/update` 通过持久 handler + eventSink 回到 Tutti，会被 `applySessionEventsByAgentSessionID` 应用并 publish 到 GUI。
- **会话生命周期层**：不会真正"通知/恢复"。这条 late 路径绕过了 `beginTurn`/`c.turns`：
  - 不创建托管 turn（Stop/Cancel 无效）；
  - 状态是否回到 Working 取决于 late 事件流是否含 `EventTurnStarted`，否则会话保持"已停止"；
  - 是否真正"唤醒主模型继续干活"取决于 ACP 是否自动续轮，Tutti 本身不补 prompt。
- 一句话：**当前架构下，委托是"发出即结束本轮"，主 Agent 的托管会话不会因为子 Agent 跑完而被可靠地恢复为运行态。**

## 待最终确认的一个外部行为（影响修复选型）

> **更新（2026-06-30）：已实测确认，详见下方「实测确认」小节。** 结论：ACP **不在**同一 prompt 调用内续轮（prompt 在子 Agent 仍在跑时就返回 `end_turn`），子 Agent 完成走 out-of-turn 流，且这些 late 事件**不带 `EventTurnStarted`**。

`claude-agent-acp` 子进程在后台 `Task` 完成后，是**在同一个 `prompt` 调用内续轮**（即 prompt 调用此时其实不该返回 end_turn），还是**返回 end_turn 后另起 out-of-turn 流 / 等待客户端再 prompt**？

验证方式：在 `standard_acp_adapter.go` 的 exec/handle 日志（已有大量 `slog.Info`，如 `agent_session.acp.exec.message`、`exec.call_completed`）下，跑一次"主 Agent 用后台 Task 委托子 Agent 后停下"的真实场景，观察：

- `prompt` 调用是否在子 Agent 仍在跑时就返回 `end_turn`；
- 子 Agent 完成时是否有 `emit==nil` 的 out-of-turn `session/update` 到达；
- 这些 late 事件里有没有 `EventTurnStarted`。

这决定修复落点：

- 若 ACP 会续轮但走 out-of-turn → 修复重点是"把 out-of-turn 续轮纳入托管 turn"。
- 若 ACP 不续轮 → 还需 Tutti 端在检测到后台委托未结束时，避免过早把会话判为终态，并提供恢复 / 续轮入口。

## 实测确认（2026-06-30，已复现）

用一条强制委托的 prompt 跑了一个真实 Claude Code 会话（prod 会话 `21247030-8081-4a05-a1d9-f55221e77d00`），对照 `~/.tutti/logs/tuttid.log` 与 `tutti agent session-summary`，上面的「待确认」已全部坐实：

- **会话时间线**：`tool_call: Agent`（用 Agent/Task 工具派出子 Agent）→ 主模型输出「The subagent is running in the **background**. I'll wait for it to return…」→ 本轮结束。
- **end_turn 时刻**：`agent_session.acp.exec.call_completed` 在 `16:44:53.398` 返回 `stop_reason=end_turn`，`exec.finished` 紧随其后 → 会话回落 `Ready`（"已停止"）。
- **约 4 秒后（16:44:54–16:44:57）**，子 Agent 输出以 **out-of-turn** 形式到达：日志中是裸 `agent_session.acp.handle_message` / `handle_message.update`（**没有** `exec.message`/`exec.start` 包裹），即走持久 handler → `applySessionEventsByAgentSessionID`，绕开 `beginTurn`/`c.turns`。
- 这些 late 事件的 `event_type_counts` 全是 `session.updated`，**不含 `turn.started`**；其后没有新的 `exec.start`。

**两个分支问题的确定答案：**

1. ACP **不会**在同一 prompt 调用内续轮——prompt 在子 Agent 仍在跑时就返回了 `end_turn`，子 Agent 完成后走 out-of-turn 流。
2. late 事件**不带 `EventTurnStarted`** → 会话停在 `Ready`，主模型不会被唤醒，它承诺的"等子 Agent 返回后再回复"那句最终回复**从未产生**。

⇒ 修复落点确定为方案 A：**既要在 end_turn 时不把仍有 pending delegate 的会话判为终态，也要把 late 续轮纳入托管 turn**——不能只指望 ACP 续轮（它不续）。

> 补充：短子 Agent 时会话最终仍会 settle 成 `completed`；"看起来已停止"的窗口长度 ≈ 子 Agent 运行时长，长任务才明显。复现方法：用 worktree 编译插桩版 `tuttid`（`services/tuttid/builtin-apps/generated/**` 需从已构建的 checkout 拷贝），以 `TUTTI_ENV=development TUTTID_LOG_OUTPUT=file TUTTI_LOG_DIR=<dir>` 跑（隔离 `~/.tutti-dev`）；注意 `tutti` CLI 不认 `TUTTI_ENV` 做 daemon 发现，需 `TUTTID_LISTENER_INFO_PATH` 指向 dev listener。

## 修复方案（落点已确认：方案 A）

### 方案 A（推荐，最小且对症）：识别"存在未完成的后台委托"，避免过早判终态 + 把 late 续轮托管化

1. 在 `standardACPUpdateEvents` / 工具调用归一化处标记后台委托：当 `Task`/`Agent` 工具以后台模式派发（工具调用 completed 但代表的是"已派发"而非"已完成"）时，记录该会话存在 pending delegate（计数 / 集合）。
2. turn 收尾时（`Exec` 的 `end_turn` 分支 / `finishTurn`）：若该会话仍有 pending delegate，**不要**把状态直接回落为 `Ready`，而是引入一个明确的中间态（如 `SessionStatusWaiting` 语义的"等待委托结果"），让 GUI 显示"等待委托 Agent"而非"已停止"。
3. 当后台委托完成的 out-of-turn 事件到达 `applySessionEventsByAgentSessionID` 时：若识别到对应的 delegate 完成，将其纳入一个**托管的轻量 turn**（注册到 `c.turns` 并带 cancel），使 Stop/Cancel 可用、状态正确回到 `Working` 再到 `Ready`，与正常 turn 行为一致。
4. pending delegate 清空且无活跃 turn 时，才允许回落到 `Ready`。

### 方案 B（更彻底）：为 out-of-turn 续轮建立"被动 turn"通用机制

- 在 controller 增加 `beginPassiveTurn` / 收尾逻辑：当 sink 收到带 `EventTurnStarted` 的 out-of-turn 事件且当前无活跃 turn 时，自动开一个托管 turn（带 cancel context），收到终态事件再 `finishTurn`。
- 这能同时修复本问题与"会话自发复活但 Tutti 接不住"一类问题，但改动面更大、需谨慎处理并发与去重。

### 测试

- 失败用例（先写）：模拟 adapter 在 `Exec` 返回 `end_turn` 后，通过 sink 投递一段代表"后台委托完成"的 out-of-turn 事件序列；断言：
  - 收尾后若存在 pending delegate，会话不是 `Ready` 而是"等待委托"中间态；
  - late 事件到达后会话经历 `Working` → `Ready` 且期间存在可被 Cancel 的托管 turn。
- 回归：普通（无委托）turn 行为不变；前台 / 阻塞式 Task（非后台）行为不变。

## 参考实现对比：Zed（同为 ACP 客户端）

读了 Zed 仓库（`/Users/asdf/Repo/zed`，`agent-client-protocol 0.14.0`，crates `acp_thread`/`agent_servers`）的客户端实现，用于对照设计。

**相同（不是差异）：**

- turn 模型一致：一次 prompt 调用 == 一个 turn（`RunningTurn{ id, send_task }`，`crates/acp_thread/src/acp_thread.rs:1456`）；任何 `stop_reason`（含 `EndTurn`）都 `running_turn.take()` → `Idle`（`:2896`，`status()` `:1810`）。
- `cancel` 在 `running_turn` 为 `None` 时直接 `Task::ready(())`，**也是 no-op**（`:3007`）——与 Tutti 的 "no active turn" 一致。
- `session/update` 由**连接级持久 handler** 处理（`crates/agent_servers/src/acp.rs:750` 的 `on_receive_notification`），`handle_session_update` **无 turn 过滤、无条件 apply**（`acp_thread.rs:1903`）——late 事件同样绕开 turn。

⇒ "turn==prompt" 与 "late 事件绕开托管 turn" 这两点 **Zed 与 Tutti 完全一样**；Zed 同样没有把 late 续轮重新纳入可 Cancel 的 turn、也不会把父线程拉回运行态。所以方案 A 第 3 步（Stop 可用 / 续轮）是**超出 Zed 现状**的部分，需自行设计。

**真正差异：子 Agent 的运行时建模（Zed 领先，正是本修复要补的）**

- Zed 把子 Agent 建成一等对象：`SubagentSessionInfo{ session_id, message_start_index, message_end_index }`（`acp_thread.rs:264`），meta key `subagent_session_info`；并有 `tool_call_for_subagent(session_id)`（按子 session id 反查父 tool call，`:2543`）、`is_subagent_root`、`subagent_spawned` 事件（`:2332`）。
- 关键：`message_end_index: Option<usize>` —— `None` 表示"子 Agent 输出尚未返回"，**这就是天然的 pending-delegate 标记**；late 事件会被 apply 进线程并嵌套渲染在那个仍 in-progress 的父 tool call 下。
- 对比 Tutti：`childSessionID` **仅展示**、无任何关联或"是否返回"标记，dispatch 一返回就把工具卡标完成、会话标停止 → 双重误判。

**结论**：Zed 不是靠更好的 turn 机制规避本问题，而是靠"子 Agent = 有 session id、有是否返回标记、能挂回父 tool call 的一等对象"。**方案 A 第 1 步建议直接参考 `SubagentSessionInfo` 的字段设计。**

## 不在本次范围

- 跨独立 Tutti 会话（`tutti claude/codex start`）的父子链路与回调——当前完全不存在，属另一项更大的产品改动，不在本修复内。
