# 2026-07-07 兼容代码 / 废弃代码清扫 Backlog

> Status: active backlog
>
> 用途: 给主 agent 长期编排“扫描分区 -> 识别确认为无用的兼容/废弃代码 -> 提交 MR -> 回填结果”的任务清单。

## 目标

- 以文件夹为主边界，持续清扫已经失去业务价值的兼容代码、历史迁移残留、废弃分支、伪入口、过时测试夹具与重复适配层。
- 避免把“仍被当前架构或历史数据兼容要求锁住的代码”误删。
- 让每个子 agent 拿到一个足够窄、可独立提交 MR 的扫描片区。

## 不要误删的东西

以下内容默认不算“废弃代码”，除非子 agent 能拿出反证：

1. 历史数据迁移、升级测试、降级兼容测试。
2. OpenAPI / generated client / protocol schema 中仍对外暴露的兼容字段。
3. AgentGUI 当前文档明确要求保留的兼容层。
4. 仅用于旧快照、旧 mention、旧 session 恢复的读路径。

进入 `packages/agent/gui/*` 或桌面 AgentGUI 相关代码前，先看：

- `docs/architecture/agent-gui-node.md`
- `docs/architecture/agent-activity-packages.md`
- `docs/specs/2026-07-01-agent-unified-dock-rd-acceptance.md`

尤其注意：当前 unified dock 方案明确要求保留 `agent-gui` / provider-specific legacy ids / 历史 session 与 workbench state 兼容。不要把这些直接当作删除目标。

## 子 Agent 交付标准

每个子 agent 必须完成下面四件事：

1. 扫描自己片区内的 `legacy` / `compat` / `deprecated` / `fallback` / `obsolete` 线索。
2. 把命中的代码分成三类：
   - `required-compat`: 仍需要保留，给出证据。
   - `cleanup-now`: 已确认无用，可在本 MR 删除。
   - `follow-up`: 需要上游合同或邻近分区先收口。
3. 若存在 `cleanup-now`，直接提交窄 MR，包含测试与必要文档更新。
4. 回报主 agent：
   - 扫描结论
   - 删除了什么
   - 哪些项确认必须保留
   - 是否需要拆出后续任务

## 主 Agent 编排规则

1. 优先派发“低依赖、能快速形成真删减”的片区。
2. 避免同时派发会修改同一份协议/同一套 AgentGUI 状态模型的相邻任务。
3. 对于扫描后确认“必须保留”的兼容层，要把 backlog 状态改成 `keep` 或 `blocked`，避免反复派单。
4. 若某任务发现新的独立片区，允许子 agent 回填新增任务。

## 热点概览

基于一次仓库扫描的粗略密度：

| Area                 | Code files | Compat-like hits | Notes                                                                  |
| -------------------- | ---------: | ---------------: | ---------------------------------------------------------------------- |
| `packages/agent`     |        976 |              870 | 最大热点；但大量 compat 是有意保留的运行时 / AgentGUI 边界             |
| `apps/desktop`       |        895 |              218 | 重点在 `workspace-agent`、`desktop-preferences`、`workspace-workbench` |
| `services/tuttid`    |        473 |              214 | 重点在 workspace 数据迁移、偏好设置、agent sidecar                     |
| `packages/workspace` |        378 |               99 | 多为 mention / app-center / file-manager 兼容边角                      |
| `packages/workbench` |        140 |               36 | 以 surface/host 兼容输入为主                                           |
| `packages/clients`   |         28 |               21 | 多数受 OpenAPI / wire contract 约束                                    |

## 当前推荐派发顺序

### Wave 1: 高确定性、低冲突

1. `desktop-preferences`
2. `services/tuttid/service/preferences`
3. `services/tuttid/data/workspace`
4. `packages/workspace/*`

### Wave 2: AgentGUI 外围兼容层

1. `packages/agent/gui/workbench`
2. `packages/agent/gui/contexts`
3. `apps/desktop/.../workspace-workbench`

### Wave 3: AgentGUI 核心流

1. `apps/desktop/.../workspace-agent`
2. `packages/agent/gui/agent-gui`
3. `packages/agent/gui/shared`

### Wave 4: 协议 / 运行时尾账

1. `packages/agent/daemon/runtime`
2. `packages/clients/tuttid-ts`

## 子任务清单

状态枚举：

- `todo`: 可直接派发
- `blocked`: 依赖上游合同或前置任务
- `keep`: 已确认应保留，不再反复扫描
- `done`: 已完成

| ID      | Priority | Folder slice                                                                   | 目标                                                                                                                                                        | 依赖/提醒                                                                 | Status    |
| ------- | -------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| `CC-01` | P0       | `apps/desktop/src/renderer/src/features/desktop-preferences/**`                | 审核 `agentDockLayout: "legacySplit"` 相关读写、归一化、测试夹具，删除 renderer 侧已无行为价值的分支与冗余测试。                                            | 允许保留 wire-contract 兼容；不要直接改 daemon 合同。                     | `todo`    |
| `CC-02` | P0       | `services/tuttid/service/preferences/**`                                       | 审核 provider-keyed composer defaults 与 `legacySplit` 偏好在 service 层的冻结兼容逻辑，识别哪些逻辑仅为写入忽略/读出透传，哪些已可裁剪。                   | 已确认 service 层 compat 需保留；删除需联动 schema/API/eventstream/data。 | `keep`    |
| `CC-03` | P0       | `services/tuttid/data/workspace/**`                                            | 审核 agent target / desktop preferences / topic 相关 legacy alias、升级迁移、历史 schema 读路径；目标是删掉已不会再触发的迁移后残留代码，而不是删测试样例。 | 很多 `legacy` 出现在测试数据名里；别把测试夹具名当删除证据。              | `todo`    |
| `CC-04` | P1       | `packages/workspace/file-manager/**`                                           | 审核旧绝对路径、旧 host hint、旧 mention / icon fallback 的读路径；删除已无调用方的兼容分支。                                                               | 与 desktop workbench 有少量交叉，只能改 package 自己。                    | `todo`    |
| `CC-05` | P1       | `packages/workspace/app-center/**`                                             | 审核 app factory provider defaults、排序兼容、历史 source-regex / pseudo app 残留测试。                                                                     | 若发现与 desktop app center 强耦合，只做确认并拆 follow-up。              | `keep`    |
| `CC-06` | P1       | `packages/workspace/issue-manager/**` + `packages/workspace/file-reference/**` | 审核旧 provider 展示兼容、旧 handle/URI 退化逻辑，确认哪些只是历史展示兼容，哪些已可删。                                                                    | 以 package 为边界，不碰 desktop host。                                    | `todo`    |
| `CC-07` | P0       | `packages/agent/gui/workbench/**`                                              | 审核 legacy dock id、providerTargetRef、旧 selection restore、旧 title derivation 兼容层，删除 unified-dock 落地后重复或无效的本地兼容代码。                | 必读 unified-dock acceptance；不要删除明确要求保留的 legacy ids。         | `todo`    |
| `CC-08` | P0       | `packages/agent/gui/contexts/**`                                               | 审核 conversation list query key、legacy provider filter、旧 settings normalization、旧 canvas state storage 兼容字段。                                     | 允许把“必须保留的旧快照读路径”标成 `keep`。                               | `todo`    |
| `CC-09` | P0       | `apps/desktop/src/renderer/src/features/workspace-workbench/**`                | 审核 AgentGUI launch/contribution 侧的 legacy default entry、旧 mention metadata、旧 workspace-path 兼容处理，收紧仅剩展示价值的 fallback。                 | 会读到 `packages/agent/gui/workbench`，但只允许改 desktop 片区。          | `todo`    |
| `CC-10` | P1       | `apps/desktop/src/renderer/src/features/workspace-agent/**`                    | 审核 desktop Agent runtime adapter、provider status service、host input adapter 里的旧 event 归并、旧 provider/defaults overlay、废弃接口。                 | 这是大任务，只改 desktop 层，不碰 `packages/agent/gui` 内核。             | `todo`    |
| `CC-11` | P0       | `packages/agent/gui/agent-gui/**`                                              | 审核 AgentGuiNode / batch runner / terminalNode 中真正无用的旧 provider、旧 reference copy、旧 drag/launch fallback、历史 payload 兼容。                    | 高风险；必须先把“仍受历史快照兼容约束”的项标记出来。                      | `todo`    |
| `CC-12` | P1       | `packages/agent/gui/shared/**`                                                 | 审核 projection、timeline canonicalization、conversation title、tool-call labels 等 shared 层的 legacy host-api / persisted-message fallback。              | 优先删纯 projection 层残留，避免改控制器。                                | `todo`    |
| `CC-13` | P1       | `packages/agent/daemon/runtime/**`                                             | 审核 Codex app-server / ACP runtime 中已失效的旧 adapter、旧 enum alias、旧 config fallback、旧 managed-config hook 兼容。                                  | 先确认哪些来自上游 schema，不能直接删生成物。                             | `blocked` |
| `CC-14` | P2       | `packages/clients/tuttid-ts/**`                                                | 在上游 daemon/OpenAPI 合同收口后，清理由 generated types、response adapters、测试中遗留的 deprecated/legacy wire shape。                                    | 依赖 `CC-02`/`CC-03`/`CC-13`。                                            | `blocked` |
| `CC-15` | P2       | `packages/workbench/**` + `packages/browser/**`                                | 审核 host surface / snapshot / preview proxy 中仅为旧 host 或旧 preload 形态存在的兼容分支。                                                                | 当前密度不高，晚点再扫。                                                  | `todo`    |

## 已回填结果

### `CC-02` `services/tuttid/service/preferences/**`

- 结论: `no cleanup-now items confirmed`
- `required-compat`:
  - `AgentComposerDefaultsByProvider` 在 service 层仍需保留“旧写入忽略、旧存量透传”的冻结行为；它仍受 OpenAPI / generated types / eventstream payload / sqlite 迁移约束。
  - `legacySplit` 仍是当前 daemon 合同中的合法 enum 值，不能只在 `service/preferences` 片区单独删除。
  - `AgentComposerDefaultsByAgentTarget == nil` 时保留 stored 值，仍用于兼容未发送该字段的旧客户端。
- `follow-up`:
  - 若要删除 provider-keyed composer defaults，需要联动 `api/openapi`、generated types、`api/daemon_preferences.go`、`service/eventstream`、`data/workspace` 与 desktop 调用方一起收口。
  - 若要删除 `legacySplit`，需要先完成 daemon schema、eventstream、desktop/workbench 消费端的合同级收口。
- 验证:
  - `go test ./service/preferences`

### `CC-05` `packages/workspace/app-center/**`

- 结论: `no cleanup-now items confirmed`
- `required-compat`:
  - App factory provider defaults 仍需接受历史 provider 字符串，并映射到当前 `agentTargetId` 选项；desktop app center 与 issue manager contribution 仍会把 provider-style 默认值传入 package resolver。
  - App Center 排序 alias 仍与 desktop App Center 分类、rich-text workspace-app mention 排序清单重复存在；只在 package 片区删除会造成 App Center 与 mention 展示顺序不一致。
  - Runtime status alias 与 app-id runtime fallback 仍是 host-neutral package 边界的兼容读路径，当前 view-model 与 gateway 仍依赖这些归一化行为。
  - 历史 `AppCenterPanel.source.test.ts` source-regex 测试已在此前 low-value test cleanup 中删除，本片区没有残留 source-regex 测试文件。
- `follow-up`:
  - 抽出 app id alias / ordering 的单一来源，联动 `packages/workspace/app-center` 与 desktop App Center / rich-text mention ordering 后，再判断哪些旧 app id alias 可删。
  - 若要停止 provider-string app factory defaults，需要先让 desktop 调用方只传 `agentTargetId` 默认值，再收紧 package resolver。
- 验证:
  - `pnpm --filter @tutti-os/workspace-app-center test`
  - `pnpm typecheck`

## 每个任务的最小回报模板

子 agent 回报主 agent 时，至少给出：

```md
任务: CC-xx
范围: <folder slice>
结论:

- cleanup-now:
- required-compat:
- follow-up:

MR:

- <branch or MR link / commit summary>

Backlog 更新建议:

- 状态改为 done / keep / blocked
- 新增任务: CC-xxa ...
```

## 第一轮建议先派的 4 个任务

1. `CC-01` `desktop-preferences`
2. `CC-02` `service/preferences`
3. `CC-03` `data/workspace`
4. `CC-07` `packages/agent/gui/workbench`

`CC-02` 已于 2026-07-07 回填为 `keep`；后续清理请改走上面的合同级 `follow-up` 方向，不要重复派单到同一 service 片区。

这四个片区的共同特点：

- 命中密度高
- 边界相对清楚
- 既有真实删除机会，也有机会快速把“必须保留”的 compat 层标记清楚
- 不需要一开始就进入 `useAgentGUINodeController` 这种高耦合核心
