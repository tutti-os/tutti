# Agent GUI Controller 重构交接说明

> 更新时间：2026-07-11
>
> 当前分支：`codex/claude-code-sdk-refactor`
>
> 当前 HEAD：`934abbd4`（`origin/team/agent-gui-refactor`）
>
> 状态：工作树包含大量未提交改动；切片 1 已完成，切片 2 正在进行；最后一次 activation 编辑被中断，当前 typecheck 暂时不通过。

## 1. 新会话要完成什么

最终目标不是修几个 controller bug，而是按
`docs/architecture/agent-gui-refactor-plan.md` 重写 Agent GUI 的职责结构：

1. `packages/agent/activity-core` 的 workspace session engine 是 session、turn、interaction、queue、pending intent、错误和对账编排的唯一所有者。
2. daemon/runtime 提供协议事实、ProviderDescriptor、能力和目录，不让 GUI 按 provider 名称猜行为。
3. React 只保留真正的面板局部状态，例如草稿、当前选中项、弹层开关和布局。
4. `useAgentGUINodeController.ts` 最终是薄装配层，不再拥有业务状态机、重试循环、乐观覆盖层或大量时序 ref。
5. Agent GUI 按输入区、会话列表、时间线、审批、provider 就绪门槛等功能模块拆分；不允许再产生巨型文件、函数或类。

最高架构依据始终是：

- `docs/architecture/agent-gui-refactor-plan.md`

规划或编辑 Agent GUI 前还必须阅读：

- `AGENTS.md`
- `packages/agent/gui/AGENTS.md`
- `docs/architecture/agent-gui-node.md`

如果现有 Codex 实现、旧 controller 或测试写法与 refactor plan 冲突，以 refactor plan 为准。

## 2. 不要破坏的工作树背景

当前工作树约有 271 个 changed/untracked entries，不全是 controller 重构：还包括 Claude Code SDK-only 迁移、daemon/OpenAPI、ProviderDescriptor、sidecar、desktop probe 等工作。

重要约束：

- 不要 reset、checkout 或批量覆盖当前工作树。
- 不要把 Claude Code ACP 恢复回来；Claude Code 正式只走 SDK sidecar。
- 不要把团队分支中的 Codex 实现当作高于架构文档的事实。
- 修改冲突文件时必须理解当前分支和团队分支两侧意图。
- 所有业务代码文件应不超过 800 行；拆分必须按职责形成有深度的模块，不能建立 `utils/common/shared` 一类模糊目录。

## 3. 已完成的核心工作

### 3.1 引擎骨架和切片 1 已完成

`packages/agent/activity-core/src/engine/` 已具备：

- workspace + origin 唯一 engine identity；
- 串行 dispatch/reducer/effect feedback loop；
- 33ms 高频 intent 合帧；
- 宿主注入 clock/scheduler，不在 reducer 内使用 timer；
- session/turn/interaction canonical lifecycle；
- submit availability selector；
- 精确 turn cancel；
- cancel deadline、超时和迟到结果保护；
- deleted session tombstone；
- connection reconnect 和 workspace/session reconcile；
- prompt queue、send-next、suspend/resume；
- 无面板时由 desktop workspace engine 持续排队发送；
- uncertain delivery 不自动重试，等待 canonical identity 对账；
- session 域错误进入 engine。

切片 1 已在 `docs/architecture/agent-gui-refactor-plan.md` 标记完成。

### 3.2 submit pending intent 已成为单一事实源

提交链路已经完成以下迁移：

- `pendingIntents` 显式记录 requested / accepted / confirmed / uncertain / failed；
- 使用 `clientSubmitId` 和 durable message 做精确确认；
- successful send result 同时进入 pending intent 与 session lifecycle；
- controller 不再使用 `dispatchSubmitAndWait` 把 engine 结果还原成 Promise 状态机；
- controller 不再在 send success 后 patch conversation status、reload message 或 reload session state；
- submit draft 只作为 UI-local reaction 清除；失败时用户文本仍可恢复；
- optimistic user message 从 pending submit selector 投影，不再写 session overlay；
- desktop `sendInput` 的 optimistic working snapshot/rollback 已删除；
- conversation list 的 submit-pending map 和导出已删除；
- queue 删除与 pending submit 取消通过同一个 `submit/canceled` intent 原子完成；
- in-flight/uncertain submit 不允许半取消，root reducer 基于同一旧快照统一判断；
- controller 已改用 activity-core 的窄 selectors，不再直接穿透 engine state tree。

最后一次完整架构复审确认上述 submit/queue 范围没有剩余 finding。

### 3.3 queue 和 desktop host 已拆分

- 旧 GUI queued prompt runtime 已删除。
- 旧 desktop queued prompt drain coordinator 已删除。
- `promptQueue.reducer.ts` 当前 799 行，刚好低于硬限制；纯 availability、lookup、initial state、selectors 已拆为独立模块。
- desktop engine 创建、command port、scheduler 和 controller-to-engine snapshot bridge 已抽到：
  `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentSessionEngineHost.ts`
- 该 host 模块约 156 行，架构复审通过。

注意：`workspaceAgentActivityService.ts` 仍约 1,741 行，是既存体量债务。后续应按 event stream/reconcile 和 activity API/host projection 等真实职责继续拆，不能长期保留。

### 3.4 当前规模

- `useAgentGUINodeController.ts`：约 11,929 行。
- 原始规划基线：约 12,718 行。
- `pendingIntents.reducer.ts`：约 746 行。
- `promptQueue.reducer.ts`：799 行。

controller 虽然已经下降，但仍远未达到“薄装配层”，不能把当前状态视为重构完成。

## 4. 当前被中断的 activation 半成品

这一部分是新会话首先要处理的内容。

### 4.1 已经写入但尚未完成接线的内容

activity-core 已开始加入：

- `activation/requested`
- `activation/failureRecorded`
- `activation/failureCleared`
- `activation/unactivateRequested`
- `session/activate` external command
- `session/unactivate` external command
- activation requested / confirmed / uncertain / failed record
- activation timeout 和 canonical session confirmation
- `inactiveSessionIds`
- activation presentation selectors

desktop engine host 已支持 `session/activate`，但尚未支持 `session/unactivate`。

`useAgentGUIActivation.ts` 还完全是旧实现：

- 三张 React `useState` map：live state、error、error code；
- 直接调用 `agentActivityRuntime.activateSession()`；
- 直接调用 `agentActivityRuntime.unactivateSession()`；
- `markFailed` / `clearFailure` 继续写 React state。

也就是说，engine activation domain 和旧 React activation domain 目前暂时双轨，必须原子切换，不能长期共存。

### 4.2 当前 typecheck 明确失败

最新执行：

```text
pnpm typecheck
```

失败包：

- `@tutti-os/desktop`
- `@tutti-os/agent-activity-core`
- `@tutti-os/agent-gui`（主要是上游类型失败传播）

明确错误：

1. `workspaceAgentSessionEngineHost.ts` 的 command switch 没有处理 `session/unactivate`，所以 `execute()` 可能返回 `undefined`。
2. `SessionUnactivateCommand` 没有 `timeoutMs?: number`，而 effect executor 对所有 external command 读取该字段。

新会话第一步应先修这两个契约问题，再继续功能迁移：

- 给 `SessionUnactivateCommand` 补 `timeoutMs?: number`，或把所有 external command 的共同 timeout 契约放回统一 base；优先选择统一、窄而一致的 command interface。
- desktop engine host 增加 `session/unactivate` case，调用注入的 unactivate transport。
- GUI 测试 runtime 的 engine command port 同样增加 activate/unactivate 分支。
- 随后运行 typecheck 和 activity-core tests，确认半成品先恢复为绿。

### 4.3 activation reducer 仍需补的测试

现有测试覆盖 activation request、timeout 后 exact session confirmation、authoritative failure，但新增的内容还没验证：

- `failureRecorded` 和 `failureCleared`；
- unactivate 清理 activation records、写入 inactive 标记并发 command；
- unactivate 后迟到 activate command result 不能重新激活；
- 新 activate request 应清除旧 inactive 标记；
- confirmed activation 到期后的保留/清理语义；
- session removal 同时清理 activation 和 inactive state；
- 不同 workspace/session 的结果不能串线。

必须先把这些 reducer/event-interleaving tests 补齐，再切 React 消费方。

## 5. controller 当前仍承担的错误职责

以下搜索结果是下一阶段删除清单，不是可以继续扩展的 API：

### 5.1 activation 和新会话创建编排

仍在 controller 中：

- `localIsCreatingConversation`
- `pendingCreateConversationId`
- `startingConversationIdRef`
- `optimisticComposerTarget` / `optimisticComposerTargetRef`
- `pendingActivationComposerSettingsPatchRef`
- `pendingHomeErrorRef`
- `failedNewConversationIdsRef`
- `startConversation` 内的大段 async IIFE / then / catch / finally
- optimistic conversation 手工创建、切换、失败回首页、stale unactivate、成功后 attach 等时序

目标：

- activate/unactivate 只派发 engine intent；
- “是否创建中、激活失败、当前 activation request”只读 selector；
- optimistic conversation 从 pending activation record 纯投影；
- 失败回首页仅是导航/UI reaction，不再维护另一套 session 真相；
- stale result、late result、unactivate 和确认规则全部由 reducer 决定。

### 5.2 新会话首条乐观消息和 overlay

仍在 controller 中：

- `recordLocalMessages`
- `retargetOptimisticPromptTurn`
- `pendingTurnIdBySessionIdRef`
- session-view `overlayMessages`
- 新建会话时直接写 optimistic prompt 到 overlay；
- state patch 到达后手工 retarget pending turn。

已有 submit pending intent 已证明不再需要这套写法。新会话应让 activation record 持有：

- `clientSubmitId`
- initial content / display prompt
- requested timestamp
- target/cwd/title/settings

然后由 selector 投影临时 conversation 和首条 user message。canonical session/message 到达后按 identity 自然去重；不要再写 overlay 后手工 retarget。

### 5.3 pre-activation settings

`pendingActivationComposerSettingsPatchRef` 当前负责：session 尚未创建时暂存设置，成功后再 flush RPC。

这不是普通组件局部状态，而是跨异步生命周期的业务编排。建议在 activation/pending-intent domain 中明确建模：

- activation request 内的初始 settings；
- activation 在途时发生的 settings patch；
- attach 后由 reducer 发出 update-settings command；
- activation 失败/被取代时丢弃 patch；
- late result 不得把 patch 发给复用相同 ID 的未来 session。

不要只是把这个 ref 搬到另一个 hook。

### 5.4 旧 session-view / conversation-list 覆盖层

仍然存在大量：

- `overlayMessages`
- `mergeAgentSessionViewOverlayMessages`
- `setAgentSessionViewOverlayMessages`
- controller 对 conversation list 的本地 created/transient patch
- detail/control-state 的并行本地投影

切片 2 的完成标准是乐观逻辑只剩 engine pending intents；切片 5 的完成标准是 conversation list store 退役。删除必须按消费链路原子完成，不能再加临时双写。

### 5.5 其他仍在 controller 的业务块

后续还包括：

- interactive approval/question/plan response 的在途布尔；
- delete/rename/pin 等操作在途状态与乐观 patch；
- composer settings update 队列；
- session state patch 兼容处理；
- message paging/loading；
- provider readiness 和 composer option 编排；
- conversation list projection/sync；
- notification、trace、diagnostic glue。

每一块都要先判断关闭所有面板后是否仍应存在：

- 仍应存在：归 engine 或 daemon。
- 只属于单个面板：归对应 React 功能模块。
- 只是防御旧 effect 时序：直接删除，不迁移。

## 6. 建议的继续顺序

### 阶段 A：恢复 activation 半成品为绿

1. 修 external command 契约和 desktop `session/unactivate` port。
2. 补 activity-core activation reducer tests。
3. 补所有 GUI test runtime 的 activate/unactivate command execution。
4. 跑：

   ```bash
   pnpm --filter @tutti-os/agent-activity-core test
   pnpm lint:ts
   pnpm typecheck
   pnpm check:agent-activity-runtime-boundaries
   ```

### 阶段 B：原子替换 `useAgentGUIActivation`

1. 让 hook 接收/读取 `AgentSessionEngine`。
2. `activate` 只 dispatch `activation/requested`；为了过渡现有调用方，可在 hook 内把 engine state completion 转成 Promise，但不能在 controller 再解释生命周期或 patch session 状态。
3. `unactivate` dispatch `activation/unactivateRequested`。
4. `stateFor/errorFor/codeFor` 读 activation selectors。
5. `markFailed/clearFailure` dispatch failure intents。
6. 删除 hook 内三张 `useState` map 和 runtime 直调。
7. 跑完整 controller spec，重点看跨 provider 切换、resume error、stale activation、卸载 unactivate。

### 阶段 C：拆除 `startConversation` 的双轨状态

1. 让 pending activation record 成为新会话临时事实源。
2. selector 纯投影 optimistic conversation、composer target、initial user message。
3. 删除 create-pending conversation map。
4. 删除 `localIsCreatingConversation`、`startingConversationIdRef`、`optimisticComposerTarget*`。
5. 把 pre-activation settings patch 作为 engine intent/command 编排。
6. 删除新会话 overlay 写入、pending turn retarget 和失败 rollback 的并行 session 状态。
7. 失败只产生明确 pending intent error 和 UI 导航结果；输入草稿必须可恢复。

### 阶段 D：完成切片 2

1. 清理剩余 overlay store 的乐观职责。
2. 所有“某操作在途”从 pending intent selector 派生。
3. 缩窄 `PendingSubmitIntentRecord.result`：controller 已不消费完整 transport result，后续只保留确认所需 turn/session version。
4. 架构复审确认只有一个 optimistic reconciliation owner。
5. 更新 refactor plan，将切片 2 标为完成。

### 阶段 E：切片 3 消费方迁移

按 refactor plan 逐个迁移：

- 消息中心
- dock badge
- 完成通知
- 状态宠物
- Issue Manager 卡片
- App Center 启动器
- 其他 workspace agent 状态消费者

全部改读 engine selectors 后，删除：

- `agentHost.ts` 旧镜像职责；
- `workspaceAgentActivityTypes.ts` 手写镜像/遗留投影；
- desktop 遗留投影函数；
- 各消费方自己的状态推导。

### 阶段 F：功能模块拆分和薄壳

按文档切片 4～6：

1. 输入区模块：拆 `AgentComposer`，草稿留 UI，设置/目录读契约和 selectors。
2. 会话列表模块：退役 2,000+ 行 conversation list store，使用 engine selectors + 明确分页缓存。
3. 时间线模块：消息和 pending projection 单一化。
4. 审批模块：interaction collections、plan/approval/question 独立。
5. provider readiness 模块：只读 descriptor/capability/status，不出现 `provider === "claude-code"` 等业务分支。
6. `AgentGUINodeView` 和 controller 只装配 workspace id、engine、host capability、少量 render slots。

不能通过把 11,000 行 controller 原样分成多个大 hook 来宣称完成；模块必须有清晰 interface、隐藏实现并拥有单一职责。

## 7. 验证基线和最近一次绿态

在最后一次 activation 半成品编辑之前，以下验证通过：

- activity-core：152/152
- Agent GUI：2150/2150
- desktop `workspaceAgentActivityService`：16/16
- `pnpm lint:ts`
- `pnpm typecheck`（26 packages）
- `pnpm check:agent-activity-runtime-boundaries`
- `git diff --check`
- submit/queue/selector/desktop host 两轮架构复审：无 finding

当前由于第 4 节的中断，不能引用上述绿态证明最新工作树可用。新会话必须先恢复绿态，再开始更大迁移。

每个切片至少执行：

```bash
pnpm check:agent-activity-runtime-boundaries
pnpm --filter @tutti-os/agent-activity-core test
pnpm --filter @tutti-os/agent-gui test
pnpm lint:ts
pnpm typecheck
```

涉及 desktop：

```bash
pnpm --filter @tutti-os/desktop build
```

正常迭代可先跑：

```bash
pnpm check:changed
```

最终收口必须跑：

```bash
pnpm check:full
```

## 8. 新会话建议使用的开场指令

可以直接把下面内容交给新的 Codex 会话：

```text
请阅读根目录 AGENTS.md、packages/agent/gui/AGENTS.md、
docs/architecture/agent-gui-node.md、
docs/architecture/agent-gui-refactor-plan.md，
以及根目录 AGENT_GUI_CONTROLLER_REFACTOR_HANDOFF.md。

继续当前 codex/claude-code-sdk-refactor 工作树，不要 reset 或覆盖其他改动。
以 agent-gui-refactor-plan.md 为最高架构依据。

先处理 handoff 第 4 节被中断的 activation 半成品：恢复 typecheck，补齐
session/unactivate command port 和 reducer 交错测试；然后原子替换
useAgentGUIActivation 的 React 状态与 runtime 直调。验证通过后，按第 6 节继续
拆 startConversation 的 pending create、optimistic overlay、settings patch 和 refs。

保持 goal：最终让 useAgentGUINodeController 成为薄装配层，完成消费方迁移和
功能模块拆分；不要把临时兼容或测试通过当成最终完成。
```

## 9. 完成判定

只有以下条件都成立，才能认为 controller 重构目标完成：

- refactor plan 切片 1～7 的适用退出标准有代码和验证证据；
- engine 是 session/turn/interaction/queue/pending/error/reconcile 唯一 owner；
- 三个旧覆盖层 store 的对应职责已经退役；
- controller 不再拥有跨面板业务状态、transport completion workflow 或 effect 时序护栏；
- controller/view/composer 已按功能模块拆分，无新增 >800 行业务文件；
- consumer 状态口径统一读 selectors；
- provider 行为只读 descriptor/capabilities/catalog；
- durable docs 与真实数据流一致；
- 架构复审无 finding；
- `pnpm check:full` 通过。

在此之前，goal 必须保持 active。
