# Agent Unified Dock RD 与 Loop Primitive 验收

日期: 2026-07-01
状态: foundation cleanup complete; ready for next implementation/refactor session
输入 PRD: `docs/specs/2026-07-01-agent-unified-dock-prd.md`
范围: 需求开发文档、实现前架构准备、Loop Primitive RD Acceptance Test

## 背景

当前 AgentGUI 已经支持一个 `agent-gui` workbench node type 下的多 provider
节点。Codex 的 legacy dock id 是 `agent-gui`，Claude Code 等 provider 使用
`agent-gui:<provider>`。Workbench dock model 也已经支持 entry-centric dock、
`dockEntryId` affinity、entry-level `matchNode` 和 transient launch payload。

PRD 要求第一阶段把 Codex 与 Claude Code 的 dock 入口聚合成一个 Agent dock
entry，但不能把 AgentGUI 节点变成单例，也不能迁移历史 session/workbench
state。实现范围已明确比最初保守草案更进一步：本期包含 system Agent Target
id 的 target-first launch/runtime attribution，以及 target-scoped composer options
缓存；但仍不包含完整 target-aware composer UX、用户自定义 persona 或历史数据重写。

现有实现证据:

- `packages/agent/gui/workbench/launch.ts` 保留 `agent-gui` -> Codex 的 legacy
  default，并从 payload/dock id/type id 解析 provider。
- `packages/agent/gui/workbench/contribution.ts` 的 AgentGUI node definition 使用
  `instance: { mode: "multi" }`，dock entries 当前按 provider map 生成。
- `packages/agent/gui/workbench/state.test.ts` 覆盖 instance id provider normalizer
  和 opaque provider target ref 的持久化兼容。
- `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts`
  当前 query 以单 provider 为维度。
- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
  当前从 `data.provider` 同时派生 conversation list query、provider target、composer
  options/defaults。

## 目标

1. 默认体验保持 legacy split dock。
2. 新增 `AgentDockLayout = "legacySplit" | "unified"` presentation preference，
   默认 `legacySplit`。
3. 新增 daemon-owned `agent_targets` registry，第一阶段只初始化 Codex 与 Claude Code
   system target。
4. `launch_ref_json` 必须是受控 union，不允许承载 skill、prompt、MCP、model、
   permission 或 composer defaults。
5. unified 模式只聚合 dock 入口；Codex 与 Claude Code 的 provider-specific
   AgentGUI nodes 仍可同时多开。
6. legacy launch id、历史 workbench node state、历史 session 继续兼容。
7. unified AgentGUI 顶部 filter 仅影响 conversation list，不能联动 composer
   provider/target/defaults。
8. system Agent Target id 可作为本期本地 CLI launch 的首选 authority；daemon
   负责从 `agent_targets.launch_ref_json` 派生 provider/runtime ref。
9. AgentGUI `@` 面板把 agent 候选从 `workspace-app` 迁出到独立
   `agent-target` provider；`workspace-app` 不再返回 `agent-codex` /
   `agent-claude-code` 伪应用。

## 非目标

- 不实现用户自定义 agent personas。
- 不把 skill/profile/prompt/model/permission 配置放进 Agent Target。
- 不迁移、重写、合并历史 sessions 或 workbench state。
- 不删除 `agent-gui`、`agent-gui:codex`、`agent-gui:claude-code` 等 legacy
  兼容路径。
- 不把所有 provider 强制塞进一个 singleton AgentGUI window。
- 不设计完整 target-aware composer UX；本阶段允许持久化和使用 system
  Agent Target id 做 launch/runtime attribution 与 target-scoped composer options
  缓存，但不做 user-defined persona、target 编辑、target 默认模型/权限、
  prompt template、skill 或 MCP 配置。
- 不保留历史 `mention://workspace-app/agent-codex?...` /
  `mention://workspace-app/agent-claude-code?...` 的特殊打开或解析兼容；它们可作为
  历史展示 token 存在，但不再作为新 `@` 查询或 launch authority。
- 不删除 `tutti codex start` / `tutti claude start` 等 provider 便利 CLI 命令；
  breaking change 只作用在 `@` mention discovery identity。

## 术语

- Provider: 实际执行 provider，例如 `codex`、`claude-code`。
- Agent Target: UI 可选 launch target。第一阶段 system target 与 native local CLI
  provider 一一对应。
- Launch ref: daemon 校验后的 provider-facing union，例如
  `{ type: "local_cli", provider: "codex" }`。
- Legacy split: 现有 Codex / Claude Code 分开的 dock entry。
- Unified dock: 单个 Agent dock entry 聚合全部 AgentGUI nodes，但不改变节点 provider。
- Conversation filter: AgentGUI 顶部列表筛选状态，取值 `all | provider`。
- Composer state: draft、provider target、model/reasoning/permission defaults 等创建或提交
  会话所需状态。
- External `@` provider: rich-text `@` 面板与 `window.tuttiExternal.at.query`
  暴露的 provider id，例如 `workspace-app`、`agent-session`、`agent-target`。
- Agent Target `@` provider: 新增 `agent-target` provider，以 Agent Target id
  作为 item/entity identity，承载 Codex、Claude Code 以及未来自定义 agents。

## 用户行为

### Legacy Split

- 默认进入 legacy split。
- Dock 仍展示 provider-specific entries。
- 点击 Codex entry 创建或聚焦 Codex AgentGUI node。
- 点击 Claude Code entry 创建或聚焦 Claude Code AgentGUI node。
- 现有 legacy launch ids 解析不变。

### Unified Dock

- 首轮 rollout 中，用户通过 Developer 设置面板中的 `agentDockLayout` 控制切到
  unified。该入口位置是 rollout 决策；底层仍走现有 desktop preference system。
- Dock 只展示一个 Agent entry。
- 如果已有 AgentGUI nodes，dock popup/minimized preview 按现有 grouped dock 行为展示
  Codex 与 Claude Code nodes。
- 如果没有 AgentGUI node，点击 Agent entry 创建第一可用 target 对应的 provider-specific
  AgentGUI node。
- 创建后的 node 仍带 provider identity，标题、composer defaults、session activation
  都按 provider-specific 规则执行。

### Conversation Filter

- 顶部 filter 选项固定为 `All`、`Codex`、`Claude Code`。
- `All` 展示所有 provider sessions。
- provider filter 使用 `session.provider` 筛选，历史 session 没有 `agent_target_id`
  也必须可见。
- 切换 filter 不改变 composer provider、selected target、draft 或 default provider。

### AgentGUI `@` 面板

- `@` 面板新增 Agents tab，数据源是 `agent-target` provider。
- `@` 面板 Apps tab 继续使用 `workspace-app` provider，但不再包含 agent 伪应用。
- 第一阶段 Agents tab 展示 `local:codex` 与 `local:claude-code`。
- 选择 agent 候选插入 `agent-target` mention，而不是
  `workspace-app` mention。
- 第三方 app 调 `window.tuttiExternal.at.query` 且不传 `providers` 时，默认结果仍包含
  agents，因为默认 provider 集合包含 `agent-target`。
- 第三方 app 显式传 `providers: ["workspace-app"]` 时，只返回应用，不返回 agents。
- 历史 `mention://workspace-app/agent-codex?...` /
  `mention://workspace-app/agent-claude-code?...` 不再需要可打开；新查询不得继续生成这种
  mention。

## 数据模型

### agent_targets

Daemon 在 `services/tuttid` 拥有持久化与校验:

```sql
agent_targets (
  id text primary key,
  provider text not null,
  launch_ref_json text not null,
  name text not null,
  icon_key text,
  enabled integer not null default 1,
  source text not null,
  sort_order integer not null default 0,
  created_at_ms integer not null,
  updated_at_ms integer not null
)
```

第一阶段系统 rows:

- `local:codex`: provider `codex`，launch ref `{ "type": "local_cli", "provider": "codex" }`。
- `local:claude-code`: provider `claude-code`，launch ref `{ "type": "local_cli", "provider": "claude-code" }`。

### Launch Ref Union

```ts
type AgentTargetLaunchRef = {
  type: "local_cli";
  provider: "codex" | "claude-code";
};
```

规则:

- `type` 必须是已知 discriminator。
- `launch_ref_json.provider` 必须等于 table `provider`。
- UI label、icon、sort、enabled、source 不从 `launch_ref_json` 读取。
- composer defaults、model、permission、MCP、skill、prompt template 不允许进入
  `launch_ref_json`。
- 未来 profile 配置应放在独立 profile/config table，再由 union 只引用稳定 id。

### External `@` Provider Contract

新增 provider id:

```ts
type TuttiExternalAtProviderId =
  | "file"
  | "workspace-issue"
  | "workspace-app"
  | "agent-session"
  | "agent-generated-file"
  | "agent-target";
```

第一阶段 `agent-target` query result:

- `providerId`: `agent-target`
- `itemId`: Agent Target id，例如 `local:codex`
- `insert.mention.entityId`: Agent Target id
- `insert.mention.scope`: 第一阶段 local Agent Target 可省略；除非未来
  multi-workspace/shared-target 需要额外上下文，否则 canonical mention 不携带
  workspace id
- `insert.mention.presentation`: display name、icon、provider metadata

新 URI 形态:

```text
mention://agent-target/local:codex
mention://agent-target/local:claude-code
```

当前 workspace 仍由 AgentGUI props 或 `window.tuttiExternal.at.query` 的 host
上下文提供，不进入 `agent-target` mention URI。

约束:

- `agent-target` provider 只暴露可发现/可选择的 Agent Target，不暴露
  `launch_ref_json` 作为自由 launch payload。
- 启动新会话时仍以 `agentTargetId` 为 authority，由 daemon 从
  `agent_targets.launch_ref_json` 派生 provider/runtime ref。
- 未来自定义 agent 扩展到 `agent-target` provider，而不是新增一批 workspace app
  ids 或一批 provider-specific CLI shortcut。

## 偏好设置

新增 desktop preference:

```ts
type AgentDockLayout = "legacySplit" | "unified";
const defaultAgentDockLayout = "legacySplit";
```

边界:

- 存储、默认值、OpenAPI/client/event contract 属于现有 desktop preferences 链路。
- `apps/desktop` 只负责 Developer 设置入口、偏好 UI、订阅、workbench contribution
  配置。
- 该偏好只影响 dock presentation，不影响 session storage、provider runtime、Agent Target
  records 或 composer defaults。
- 首轮入口放在 Developer 面板，不代表新增独立开发者偏好系统；验收仍以
  `agentDockLayout` 的 desktop preference contract 为准。

## Dock 行为

### Layout Mode 构造

实现前需要把 AgentGUI dock entry 构造抽成窄函数:

```ts
buildAgentGuiDockEntries({
  layout: "legacySplit" | "unified",
  targets,
  providerAvailability
});
```

预期:

- `legacySplit`: 返回 provider-specific dock entries，保持现状。
- `unified`: 返回一个 Agent dock entry，`matchNode` 覆盖 Codex 与 Claude Code AgentGUI
  nodes。
- unified entry 的 launch payload 只描述默认 target/provider，不持久化到 snapshot。
- provider-specific node `dockEntryId`/instance id 兼容 legacy；必要时通过 `matchNode`
  fallback 让历史 node 被 unified entry 聚合。

## Launch 兼容

保留现有 normalizer:

- `agent-gui` => Codex。
- `agent-gui:codex` => Codex。
- `agent-gui:claude-code` => Claude Code。
- payload provider 优先级高于 dock identifier。
- session launch 若提供 session id，应以 session provider 打开/聚焦 provider-specific node。

实现要求:

- 隔离 provider-specific launch descriptor。不要让 unified dock entry 的 id 替代 provider
  identity。
- unified 模式下 launch result 仍创建 provider-specific `instanceId`。
- AB 切换不修改历史 node state。

## Conversation Filtering

新增独立 filter model，不能复用 node `data.provider`:

```ts
type AgentGUIConversationFilter =
  | { kind: "all" }
  | { kind: "provider"; provider: "codex" | "claude-code" };
```

Conversation list query 应改为:

- provider node identity: 继续来自 `data.provider`，用于 composer/runtime。
- list filter: 独立 UI-local state，用于过滤 conversations。
- query key: 包含 workspace/user/sessionOrigin/filter，不能把 `all` 偷映射成某个 provider。

## Composer 独立性

Composer 继续由 node provider、selected provider target、draft settings 和 daemon composer
options 决定。当前迭代允许 system Agent Target id 参与 target-backed local CLI
launch、runtime attribution 和 composer options cache key；顶部 filter 不得调用:

- `onDataChange` 更新 `data.provider` / `providerTargetId` / `providerTargetRef`。
- `rememberAgentComposerDefaults`。
- `setDefaultAgentProvider`。
- draft settings mutation。

建议增加 controller 级测试: 切换 filter 后 `viewModel.composerSettings`、`selectedProviderTarget`、
`data.provider`、home draft key 均不变。

## Target-First Launch/Runtime Attribution

本期允许比最初保守草案更深入地使用 Agent Target:

- AgentGUI/workbench 可以把 first-iteration system target id 写入 node state，并随
  create/activate session 请求传给 Agent Activity runtime。
- desktop adapter 在有 `agentTargetId` 时不应让 opaque `providerTargetRef` 成为
  runtime launch authority。
- tuttid session create 以 `agentTargetId` 为首选 authority：读取
  `agent_targets`，校验 enabled 与 controlled launch ref，派生真实 provider 和
  provider-facing runtime ref。
- 如果请求同时带 `provider`，它必须与 target launch ref 派生 provider 一致。
- session projection 和 activity event 可以携带 `agentTargetId`，但历史无
  `agentTargetId` 的 session 继续按 `session.provider` 工作。
- 该范围仍不是完整 target-aware composer UX；target editing、persona/profile、
  model/permission defaults、prompt/skill/MCP 配置继续留到后续设计。

## API / Runtime 边界

- `services/tuttid`: `agent_targets` storage、default rows、launch ref validation、desktop
  preference persistence、OpenAPI contract、target-first create-session resolution、
  Agent Target candidate listing。
- `apps/desktop`: preference wiring、provider availability probing、workbench contribution
  layout mode、Developer-panel rollout entry、settings UI copy/i18n、rich-text
  `agent-target` provider wiring、`window.tuttiExternal.at.query` bridge。
- `@tutti-os/agent-gui`: reusable presentation、target list consumption、conversation filter model、
  first-iteration system target id propagation、controller/view-model 行为、`@` 面板
  Agents tab 分组与 `agent-target` mention 插入。
- `@tutti-os/workspace-external-core`: `agent-target` external `@` provider id
  public contract 与默认 provider 列表。
- `@tutti-os/workbench-surface`: 不理解 Agent Target 业务语义，只消费 dock entries、
  launch payload、dock grouping。

## 实现前 Readiness Review

结论: ready after cleanup。

需要小型整理，范围要窄:

1. 抽离 dock layout mode 构造
   - 文件: `packages/agent/gui/workbench/contribution.ts` 及测试。
   - 收益: 把 split/unified 差异限制在 dock entries 构造，避免改动 node lifecycle。
   - 风险: popup grouping 误匹配历史 nodes。
   - 测试: split entries、unified single entry、unified `matchNode` 覆盖 Codex/Claude Code。

2. 隔离 provider-specific launch descriptor
   - 文件: `packages/agent/gui/workbench/launch.ts` 及 `launch.test.ts`。
   - 收益: unified dock id 不污染 provider identity。
   - 风险: session launch 或 draft prefill 复用错误 provider node。
   - 测试: legacy ids、payload provider 优先、session id provider resolution、unified entry launch。

3. 增加独立 conversation filter model
   - 文件: `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/**`、
     `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`。
   - 收益: 明确 filter 只影响 list。
   - 风险: 误把 filter provider 写回 composer/node provider。
   - 测试: all/provider filtering、历史 session provider fallback、filter 切换不改变 composer。

4. 拆分 AgentGUI `@` 面板 agent discovery
   - 文件:
     `packages/workspace/external-core/src/contracts/index.ts`、
     `apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtService.ts`、
     `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceWorkbenchHostService.ts`、
     `packages/agent/gui/agent-gui/agentGuiNode/AgentMentionSearchController.ts`。
   - 收益: Apps tab 与 Agents tab 语义分离，为未来大量 custom agents 留出扩展位。
   - 风险: 第三方 app 显式查询 `workspace-app` 时不再看到 agents；这是产品接受的
     breaking change。
   - 测试: external provider ids、默认 provider 列表、显式 `workspace-app` 过滤、
     `agent-target` query/serialize、AgentGUI tab grouping。

不建议在实现前做大整理:

- 不拆 `useAgentGUINodeController.ts` 大模块。
- 不迁移历史 workbench snapshots。
- 不改 provider runtime。
- 不把 future profile/persona 设计提前塞入 Agent Target。

实施顺序:

1. Daemon 加 `agent_targets` 与 desktop preference contract，默认 `legacySplit`。
2. AgentGUI workbench 层完成 layout mode builder 与 launch descriptor 测试。
3. Desktop wiring 根据 preference 选择 split/unified contribution，并把首轮入口放在
   Developer 设置面板。
4. AgentGUI 增加 list filter model 与 UI，保持 composer provider 独立。
5. AgentGUI `@` 面板迁移: 新增 `agent-target` provider，移除 `workspace-app`
   agent 伪应用，接入 Agents tab。
6. 接入 system Agent Target id 的 target-first launch/runtime attribution。
7. 追加 e2e/manual 验收: AB 切换、历史 session/node、legacy launch、filter/composer 不联动、
   `@` 面板 Agents/Apps 分组与 external `@` bridge provider 过滤。

## Loop Primitive RD Acceptance Test

判定标准:

- PASS: PRD/RD 约束清楚，且现有架构有直接支撑或兼容证据。
- RISK: 约束清楚，但实现前需要上述小型整理或新增测试防回归。
- BLOCKED: 存在缺失决策、架构冲突或实现无法在限制内完成。

| Primitive                                      | 结果 | 证据                                                                                                                     | 后续要求                                                                                                                |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| AB 默认 `legacySplit`                          | RISK | 现有 desktop preferences 有成熟链路与 default provider 字段，但尚无 `agentDockLayout` 字段。                             | 新增 preference 必须默认 `legacySplit`，并补 daemon/desktop/client/event 测试。                                         |
| Unified 只聚合 dock 入口                       | RISK | Workbench dock entry model 支持 entry-level `matchNode`；当前 contribution 按 provider map 出 dock entries。             | 先抽 `buildAgentGuiDockEntries`，unified 只改变 entries，不改 node type/runtime。                                       |
| Provider-specific AgentGUI 节点可多开          | PASS | AgentGUI node definition 使用 `instance: { mode: "multi" }`，launch descriptor 生成 provider-specific instance ids。     | unified entry 不得改为 singleton/reuse all providers。                                                                  |
| 历史 dock/session/workbench state 兼容         | PASS | `launch.test.ts` 覆盖 `agent-gui` legacy default；`state.test.ts` 覆盖 provider normalizer 和 opaque node state。        | 保留 normalizer；unified 用 fallback match 聚合历史 nodes。                                                             |
| 不删除 legacy 兼容路径                         | PASS | `agentGuiWorkbenchProviderFromIdentifier("agent-gui")` 返回 Codex；`agent-gui:<provider>` 仍可解析。                     | 新增 unified id 时不能替换 legacy ids 的解析语义。                                                                      |
| `agent_targets` daemon-owned                   | RISK | 现有 repo 未见 `agent_targets` 持久模型；desktop preferences/storage 模式可复用。                                        | 在 `services/tuttid` 建表、默认 rows、service validation；不要只放 desktop。                                            |
| `launch_ref_json` 是受控 union                 | RISK | 现有 AgentGUI `providerTargetRef` 是 host-owned opaque ref，适合 UI 透传但不能直接等同 daemon launch ref。               | daemon 引入 strict union validator；拒绝 unknown discriminator/provider mismatch/free-form config。                     |
| Launch 兼容 provider resolution                | PASS | `agentGuiWorkbenchProviderFromLaunchRequest` payload provider 优先，再看 dock id/type id，fallback Codex。               | session-id launch 需要补“按 session provider resolution”的实现测试。                                                    |
| Default target resolution                      | RISK | 现有 `defaultAgentProvider` 与 provider status service 可作为输入，但还没有 Agent Target registry。                      | 顺序必须是 default provider 可用 -> enabled target by sort_order 且 provider available -> Codex fallback。              |
| Conversation filter 只影响 list                | RISK | 当前 `AgentGUIConversationListQuery` 必填单 provider，controller 用 `data.provider` 构造 query。                         | 增加独立 filter model/query key；filter mutation 不写 node data。                                                       |
| Historical sessions 按 `session.provider` 可见 | RISK | Conversation summaries 已含 `provider`；当前 query 是单 provider。                                                       | all/provider filter 以 session.provider 为 fallback，不能要求 agent_target_id。                                         |
| Composer provider/target/defaults 独立         | RISK | 当前 composer target/defaults 从 `data.provider` 与 selected target 派生；这正是不可联动边界。                           | filter UI 不得调用 data/default mutation；加 controller 测试。                                                          |
| Target-first launch/runtime attribution        | RISK | Agent Target registry 是 daemon-owned；AgentGUI 已有 provider target state，Activity runtime 可携带 session metadata。   | 有 `agentTargetId` 时 daemon 派生 provider/runtime ref；desktop 不让 opaque `providerTargetRef` 覆盖 target authority。 |
| Agent 从 `workspace-app` 迁到 `agent-target`   | RISK | 当前 external `@` provider id 列表没有 `agent-target`；rich-text service 对 `agent-codex` / `agent-claude-code` 有特判。 | 新增 public provider id；默认查询包含 `agent-target`；显式 `workspace-app` 查询不再返回 agents。                        |
| 历史 agent workspace-app mention 兼容          | PASS | 产品接受旧 `mention://workspace-app/agent-codex?...` 不再可打开，只作为历史展示存在。                                    | 删除特殊 open/resolve 兼容时不要影响普通 workspace-app mention。                                                        |
| API/runtime 边界                               | PASS | AgentGuiNode architecture 明确 runtime chain；PRD ownership 与现有边界一致。                                             | Agent Target 业务规则落 daemon；desktop 只 wiring。                                                                     |
| 不迁移历史数据                                 | PASS | 需求可通过 additive preference/table/default rows + normalizer 实现。                                                    | 不写 snapshot/session migration；仅 schema additive。                                                                   |

无 BLOCKED 项。主要风险都可通过窄 cleanup 与测试覆盖消解。

## Foundation Cleanup 记录

完成记录:

- PR: <https://github.com/tutti-os/tutti/pull/610>
- Branch: `feat/agent-gui-unified-dock-foundation`
- Commit: `563ad18b feat(agent-gui): add unified dock foundation`
- 结论: 前置 foundation cleanup 已完成；可以在新 session 中继续推进正式
  Agent Unified Dock 实现或下一层重构。

本次已完成的前置整理:

1. AgentGUI workbench dock identity / launch helper foundation
   - 文件: `packages/agent/gui/workbench/launch.ts`
   - 新增 `AgentGuiWorkbenchDockLayout = "legacySplit" | "unified"`。
   - 新增 unified aggregate dock entry id: `agent-gui:unified`。
   - 新增 `AgentGuiWorkbenchDockIdentity` 与
     `agentGuiWorkbenchDockIdentityFromIdentifier(...)`，把 legacy provider dock
     identity 与 unified aggregate dock identity 分开解析。
   - 保留 legacy split 行为:
     - Codex dock id 仍是 `agent-gui`。
     - Claude Code dock id 仍是 `agent-gui:claude-code`。
     - `agent-gui:codex` 仍解析为 Codex。
   - 保持 payload provider 优先于 dock id 的 launch resolution。

2. Unified aggregate launch reuse 风险已被隔离
   - 文件: `packages/agent/gui/workbench/launch.ts`
   - `createAgentGuiWorkbenchLaunchDescriptor(...)` 现在先解析真实 provider，
     再解析 launch 结果的 dock entry id。
   - provider-specific `instanceId` 继续由真实 provider 决定，不被 unified dock
     entry id 覆盖。
   - `shouldReuseAgentGuiWorkbenchDockEntryNode(...)` 明确:
     - legacy split prefill/draft 保持原有 provider dock node reuse 行为。
     - unified aggregate prefill/draft 不复用同一个 dock entry node，避免 Codex
       与 Claude Code 草稿跨 provider 误复用。

3. Conversation filter 纯模型已落地
   - 文件:
     `packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationFilter.ts`
   - 新增 `AgentGUIConversationFilter = { kind: "all" } | { kind: "provider" }`。
   - 新增 conversation summary 与 workspace activity session 的过滤函数。
   - `all` 默认只覆盖本 PRD 第一阶段目标 provider: Codex 与 Claude Code。
   - 该模型是纯函数/纯状态，不包含 composer provider、selected target、
     default provider 或 composer defaults mutation。

4. 测试覆盖已补齐
   - 文件:
     - `packages/agent/gui/workbench/launch.test.ts`
     - `packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationFilter.spec.ts`
   - 覆盖:
     - legacy dock ids 与 provider parsing。
     - payload provider 优先级。
     - unified aggregate identity parsing。
     - unified aggregate launch 仍生成 provider-specific instance id。
     - unified prefill 不跨 provider 复用 dock entry node。
     - conversation filter 的 all/provider 行为。
     - filter state 不携带 composer 字段。

已运行检查:

```sh
pnpm --dir packages/agent/gui exec vitest run --environment jsdom \
  workbench/launch.test.ts \
  agent-gui/agentGuiNode/model/agentGuiConversationFilter.spec.ts

pnpm --filter @tutti-os/agent-gui typecheck

pnpm check:full
```

下一 session 的建议起点:

1. 不要重复做 PR 610 已完成的 helper/model foundation。
2. 从 `agent-gui:unified` 和 `AgentGuiWorkbenchDockLayout` 接入正式
   `agentDockLayout` preference。
3. 继续保持 legacy compatibility 作为兼容层，不删除 `agent-gui` /
   `agent-gui:codex` / `agent-gui:claude-code`。
4. 下一步可以按以下顺序推进:
   - daemon `agent_targets` storage + strict `launch_ref_json` union validation。
   - desktop `agentDockLayout` preference，默认 `legacySplit`，首轮入口在 Developer
     设置面板。
   - AgentGUI/workbench contribution 根据 preference 选择 split/unified dock entries。
   - AgentGUI 顶部 filter UI 接入已落地的 pure filter model，并验证不联动 composer。
   - system Agent Target id 贯穿 target-first launch/runtime attribution。
   - 历史 workbench/session 兼容与 legacy launch 回归测试。

## 验收标准

### Data

- Fresh workspace 自动存在 `local:codex` 与 `local:claude-code` system targets。
- `launch_ref_json` strict decode；unknown `type`、provider mismatch、extra config blob 被拒绝或安全忽略。
- system targets 不会被普通 user edit/delete 删除。

### Settings

- `agentDockLayout` 走现有 desktop preference system。
- 默认值是 `legacySplit`。
- 首轮 UI 控制位于 Developer 设置面板。
- 修改 setting 后 dock presentation 热更新，不要求 app restart。

### Dock

- `legacySplit`: Codex / Claude Code dock entries 行为与现状一致。
- `unified`: 只显示一个 Agent dock entry。
- `unified`: Codex 与 Claude Code AgentGUI nodes 可同时打开。
- `unified`: popup/minimized preview 聚合所有匹配 AgentGUI nodes。
- 无打开节点时，Agent entry 用 default target resolution 创建 provider-specific node。

### Launch

- `agent-gui`、`agent-gui:codex`、`agent-gui:claude-code` 都路由到正确 provider。
- payload provider 优先于 dock id。
- session launch 使用 session provider 聚焦/打开对应 node。
- 有 `agentTargetId` 的 session create 由 daemon 派生 provider/runtime ref。
- `agentTargetId` 与显式 provider 不一致时拒绝创建。
- target-backed local CLI launch 不让 opaque `providerTargetRef` 覆盖 daemon-derived
  runtime authority。
- AB 切换不删除、不合并、不重写历史 nodes。

### Filtering / Composer

- 顶部 filter 仅有 All、Codex、Claude Code。
- Filter 只改变 conversation list。
- 切 filter 后 composer provider、selected target、draft、default provider、composer defaults 不变。
- 历史 sessions 没有 target id 时仍按 `session.provider` 出现在 provider filter 下。

### AgentGUI `@` 面板 / External `@`

- External `@` provider id 列表包含 `agent-target`。
- 默认 external `@` 查询包含 `agent-target` results。
- 显式 `providers: ["workspace-app"]` 查询不返回 agents。
- `workspace-app` provider 不再返回 `agent-codex` / `agent-claude-code`。
- `agent-target` provider 第一阶段返回 `local:codex` / `local:claude-code`。
- AgentGUI Agents tab 使用 `agent-target` provider。
- AgentGUI Apps tab 使用 `workspace-app` provider 且不显示 agents。
- 选择 Codex / Claude Code agent 插入 `mention://agent-target/<targetId>`。
- 新 `@` 查询不再生成 `mention://workspace-app/agent-codex?...` /
  `mention://workspace-app/agent-claude-code?...`。

## 测试策略

Focused unit tests:

- `services/tuttid/data/workspace`: `agent_targets` migration/default rows/strict launch ref validation。
- `services/tuttid/biz/preferences` + sqlite preference tests: `agentDockLayout` 默认与 normalize。
- `packages/agent/gui/workbench/launch.test.ts`: legacy ids、payload provider、session launch provider、unified launch descriptor。
- `packages/agent/gui/workbench/contribution` tests: split entries vs unified single entry、match existing Codex/Claude Code nodes。
- `agentGuiConversationListStore` tests: `all` filter、provider filter、historical `session.provider` fallback。
- `useAgentGUINodeController` tests: filter 切换不改变 `data.provider`、`selectedProviderTarget`、
  `composerSettings`、draft settings。
- `packages/workspace/external-core`: `agent-target` provider id normalize/default list。
- `DesktopRichTextAtService`: `agent-target` query maps Agent Target rows; `workspace-app`
  excludes `agent-codex` / `agent-claude-code`。
- `workspaceWorkbenchHostService.queryWorkspaceAppExternalAt`: omitted providers include
  `agent-target`; explicit `workspace-app` excludes agents。
- `workspaceAppExternalAtSerialization`: serializes `agent-target` query results and
  preserves item/entity id as Agent Target id。
- `AgentMentionSearchController` / palette model: Agents tab vs Apps tab grouping。

Integration / local validation:

- TS/package: `pnpm --filter @tutti-os/agent-gui test`。
- Desktop-facing: `pnpm --filter @tutti-os/desktop typecheck` and
  `pnpm --filter @tutti-os/desktop build`。
- Daemon data/API: `pnpm lint:go` and `cd services/tuttid && go test ./... && go build ./...`。
- Mixed change: `pnpm check:changed`。

Manual acceptance:

1. Fresh workspace: default legacy split visible。
2. Switch unified: one Agent entry visible without restart。
3. Open Codex and Claude Code from unified flow: both nodes stay open。
4. Legacy launch from CLI/app links still opens correct provider。
5. Restore old workbench snapshot: nodes render and group under unified entry。
6. Switch filter All/Codex/Claude Code: list changes, composer provider/defaults/draft do not。
7. Type `@` in AgentGUI: Codex and Claude Code appear under Agents, not Apps。
8. In a workspace app, call `window.tuttiExternal.at.query({ keyword: "codex" })`:
   Codex appears as `providerId: "agent-target"`。
9. In a workspace app, call
   `window.tuttiExternal.at.query({ keyword: "codex", providers: ["workspace-app"] })`:
   Codex does not appear。

## 原始 RD 结论

结论: ready after cleanup。

推荐下一步:

1. 先做三项窄 cleanup: dock layout mode builder、provider-specific launch descriptor 隔离、
   independent conversation filter model。
2. 再按 daemon data/preference -> workbench dock -> desktop wiring -> AgentGUI filter 的顺序实现。
3. 实现中严格保持 legacy compatibility，不迁移历史 session/workbench state。

关键依据:

- 现有 workbench dock model 与 AgentGUI multi-instance 能支撑 unified 聚合。
- legacy normalizer 与 tests 已证明 `agent-gui` 兼容路径可保留。
- 最大风险不在 dock，而在把 conversation filter 误写成 composer provider/target selection。

文档影响:

- 本次新增独立 RD/验收文档。
- 未修改 durable architecture/convention 文档；当前结论属于该 PRD 的实现前准备，不新增稳定仓库规则。

## 当前交接结论

结论: foundation cleanup complete; ready for next implementation/refactor
session。

PR 610 已经消解原始 readiness review 中最高优先级的前置风险: dock identity
foundation、provider-specific launch descriptor 隔离、unified prefill reuse 防护、
conversation filter pure model。后续工作应基于这些 helper 和测试继续推进，不再把
legacy compatibility 视为待删除代码；它现在是被测试锁住的兼容层。
