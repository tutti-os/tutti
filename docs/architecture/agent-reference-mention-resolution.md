# 引用产物按需解析(workspace-reference mention + skill + CLI)

状态:已实现(daemon `reference list` CLI provider + `reference` skill/路由 + 前端 `workspace-reference` mention;旧 `workspace-app-bundle` 展开链路已移除)
适用面:AgentGui composer 选中引用 → 发送给 agent 的产物解析链路
关联:本文是 [`agent-reference-source-services.md`](./agent-reference-source-services.md) 的增补章节。前者定义「+」picker 的**多源取数**;本文改造的是**选中之后、发送给 agent 时的序列化与解析**这一段。

---

## 0. 背景与目标

### 现状链路(要移除的)

picker 选中 app / 任务产物**文件夹**后,现状是「发送时把全部文件路径递归枚举、展开塞进 prompt」:

```
picker 选中文件夹(navigable 源)
  → confirmGrouped() 对每个文件夹调 collectFolderFiles() 递归 listChildren 枚举全部文件
  → 折叠成 workspace-app-bundle mention(href 里夹带 files JSON + icon)
  → 提交时 formatAgentMentionMarkdown(item, "agent") 把 bundle 炸成 N 条 @绝对路径
  → 这些路径整段进 prompt 文本发给 agent
```

问题:

1. **prompt 爆炸**:文件多时整串路径塞满 prompt。
2. **快照语义**:是「发送那刻」的文件清单;议题/应用后续新增产出,agent 看不到。
3. **确认卡顿**:`collectFolderFiles` 在确认那一刻**同步递归枚举**,大产物明显卡。

### 目标

- agent 收到的是一条紧凑、可解析的 **`workspace-reference` mention**;真正取文件在 agent **执行时**通过 `tutti` CLI 按需完成(实时)。
- 复用现有 mention 机制四层设定(协议 / 通用路由 / provider 强化 / skill 模板),**app 侧与 daemon API 零改动**,全部走现成进程内 service 出口。

### 已锁定的决策

| 决策          | 结论                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mention kind  | **统一新建 `workspace-reference`**;不复用 `workspace-issue` / `workspace-app`(避免被动引用触发执行式 skill),也不再用 `workspace-app-bundle` 展开                                   |
| source 取值   | 仅 **`app`** 与 **`task`** 两种;无 `issue` / `topic` 独立源                                                                                                                        |
| 句柄结构      | 两源对称 **`{ source, id(顶层容器), groupId(子级,可选) }`**。app:`id=appId`;task:`id=topicId`(类比 appId),`groupId=issueId`                                                        |
| 解析机制      | **协议 + skill + CLL**:mention 句柄 → `reference` skill → `tutti reference list ... --json` → 进程内 service 出口                                                                  |
| 统一出口      | app 走 **`AppCenterService.ListReferences`**、task 走 **`IssueManagerService.GetIssueDetail` / `SearchIssueOutputs`**,均为 daemon 进程内方法;**不在 CLI handler 自拼 HTTP 打 app** |
| 接口复用      | 标准契约 = 一条 `reference list` 命令,背后全是现成 service 方法,**app manifest / app HTTP 端点 / daemon API / service 方法 0 改动**                                                |
| URI 形态      | 复用 `buildAgentGenericMentionHref`(`mention://<kind>/<id>?<key 字母序参数>`);agent URI **不带 files 夹带、不带 label**                                                            |
| provider 覆盖 | 路由加在**通用层**(所有 provider),不仅 claude-code                                                                                                                                 |

---

## 1. 端到端链路

```
引用选中 → tiptap 插入 workspace-reference mention
  → 发送序列化成 mention://workspace-reference/<id>?source=app|task&...(不展开)
  → 路由(通用层 + claude-code 强化层)强制首个 tool call = Skill("reference", <URI>)
  → reference skill 指示 agent 跑:
        tutti reference list --source <app|task> --id <id> [--group-id <G>] --json
  → daemon references provider 分派(统一进程内出口,不自走 HTTP):
        app  → AppCenterService.ListReferences(...)             递归拍平
        task → group-id 在 → IssueManagerService.GetIssueDetail(issueId).LatestOutputs
               group-id 缺 → IssueManagerService.SearchIssueOutputs(topicId)
  → 返回扁平文件清单 { items:[{path,...}] }
  → agent 用普通文件工具读这些真实路径(~/.tutti 内)
```

> agent 能否执行 `tutti` CLI:**能**。现有 `issue-manager` 等 skill 就是这么让 agent 跑 `issue get --json` 的,同一机制。

## 1.1 Agent target mentions

Agent launch mentions are not workspace app mentions. The external `@` bridge
has a dedicated `agent-target` provider for first-party Agent targets:

- Omitted `window.tuttiExternal.at.query.providers` defaults include
  `agent-target`.
- Explicit `providers: ["workspace-app"]` returns only real workspace apps.
- New Agent mention insertions use
  `mention://agent-target/local:codex` or
  `mention://agent-target/local:claude-code`.
- AgentGUI composer host capabilities include `agent-target`; its Apps tab
  stays scoped to `workspace-app`, while its Agents tab queries `agent-target`.
- `workspace-app` must not return `agent-codex` or `agent-claude-code` pseudo
  apps. Existing historical pseudo-app mention tokens can remain display-only;
  do not create new ones.

---

## 2. 源模型(app / task 对称)

`source` 仅两值;两源结构统一为 `{ source, id(顶层容器), groupId(子级,可选) }`。心智模型一致:**先找顶层容器(app / topic),再找其下 group**。

|                      | app                               | task                                                        |
| -------------------- | --------------------------------- | ----------------------------------------------------------- |
| `source`             | `app`                             | `task`                                                      |
| `id`(顶层容器)       | `appId`                           | `topicId`(类比 appId)                                       |
| `groupId`(子级,可选) | app 子分组                        | `issueId`                                                   |
| 缺省 `groupId` 含义  | 整个 app                          | 整个 topic                                                  |
| 解析出口(进程内)     | `AppCenterService.ListReferences` | `IssueManagerService.GetIssueDetail` / `SearchIssueOutputs` |

---

## 3. 分层契约

### 3.1 Layer ① — mention 协议

**URI 形态**(`mention://<kind>/<entityId>?<key 字母序参数>`)

```
app:  mention://workspace-reference/<appId>?groupId=<G>&source=app&workspaceId=<W>
task: mention://workspace-reference/<topicId>?groupId=<issueId>&source=task&workspaceId=<W>
```

- kind = `workspace-reference`(新);path = `id`;query 带 `source` / `workspaceId`(必填)/ `groupId`(可选)。
- **不带 `files` 夹带、不带 label**(label 是 markdown 链接文字)。

**句柄解码(走现有 `locate` 同款「backend 负责解码」模式)**

```ts
// packages/workspace/file-reference/src/contracts/referenceSource.ts
export interface ReferenceHandle {
  source: "app" | "task";
  id: string;        // appId / topicId
  groupId?: string;  // app 子分组 / issueId
}
// ReferenceSourceService 新增可选方法
describeReferenceHandle?(node: ReferenceNode): ReferenceHandle | null;

// packages/workspace/file-reference/src/core/referenceListSource.ts —— ReferenceListBackend 新增
describeHandle?(groupId: string): ReferenceHandle | null;
```

- wrapper `createReferenceListSource`:node 为 group(`g:` 前缀)→ 解出 backend groupId → 调 `backend.describeHandle`(与 `locate` 包装对称)。

**app backend(零新增编码,复用现成)** —— `apps/desktop/src/renderer/src/features/agent-reference-sources/appReferenceListBackend.ts`

- 现有编码:`app:${appId}` / `app:${appId}|grp:${base64(groupId)}`,`decodeAppGroupId` 给 `{appId, groupId}`。
- `describeHandle` → `{ source:"app", id: appId, groupId }`。

**task(issue)backend 编码改动** —— `apps/desktop/src/renderer/src/features/agent-reference-sources/issueReferenceListBackend.ts`(改动全在本文件内)

- `encodeGroup` 的 issue 分支:列 topic 下 issues 时 `decoded.topicId` 已知,把 topicId 一并编进,如 `i:<base64(issueId)>.<base64(topicId)>`。
- `decodeGroup` 的 `i:` 分支:解出 `{ issueId, topicId }`(现有 `list` 的 `i:` 分支只用 issueId,不受影响)。
- `describeHandle`:`i:` → `{ source:"task", id: topicId, groupId: issueId }`;`t:` → `{ source:"task", id: topicId }`。
- `locate` 的 issue 分支:`params` 带 topicId 时同样编两段(无 topicId 的纯 deep-link 是边角场景,browse→bundle 主链路一定带 topic)。

**前端序列化** —— `packages/agent/gui/.../agentRichText/agentFileMentionExtension.ts` 等

- `normalizeMentionKind` 注册新 kind `workspace-reference`。
- 新 `buildAgentWorkspaceReferenceMentionHref(workspaceId, handle)`:由 `ReferenceHandle` 拼 URI。
- `formatAgentMentionMarkdown` 的 reference 分支:**agent 模式不再展开**,直接输出 `[@名](mention://workspace-reference/...)` 单链接;display 模式同样单链接(chip)。
- mention 节点 attrs:`{ kind:"workspace-reference", href, name, iconUrl, count }`,**不带 files 数组**;count 取节点 `childCount`。
- `AgentGUINodeView.confirmWorkspaceReferenceBundles`:用 `describeReferenceHandle(node)` 得句柄 → 建 `workspace-reference` mention item;松散单文件仍走普通 file mention(本次不动)。

### 3.2 Layer ② — CLI(`references` provider + `reference list`)

新建 `services/tuttid/service/cli/providers/references/`。

```go
type referenceListInput struct {
    Source  string `cli:"source"   validate:"required,oneof=app task"`
    ID      string `cli:"id"       validate:"required"` // appId / topicId
    GroupID string `cli:"group-id"`                     // app 子分组 / issueId,可选
    Query   string `cli:"query"`
    Limit   int    `cli:"limit"    validate:"omitempty,min=1,max=200"`
}

framework.CommandSpec[referenceListInput]{
    ID:          "references.list",
    Path:        []string{"reference", "list"},
    Summary:     "List artifact files behind a workspace-reference mention",
    Description: "Resolve a workspace-reference handle (app+group / topic+issue) into a flat file list.",
    Kind:        framework.KindList,
    Workspace:   framework.WorkspaceRequired,
    Workspaces:  p.workspaces,
    Inputs:      framework.FromStruct[referenceListInput](),
    Output: framework.OutputSpec{
        DefaultMode: cliservice.OutputModeJSON,
        JSON:        true,
        Table:       &framework.TableOutputSpec{Columns: pathNameSizeCols, Rows: ...},
        JSONValue:   func(r any) map[string]any { return map[string]any{"items": r} },
    },
    Run: p.runReferenceList,
}
```

**统一扁平输出**

```json
{
  "items": [
    {
      "path": "...",
      "displayName": "...",
      "sizeBytes": 123,
      "mediaType": "image/png",
      "createdAtUnix": 1699999999
    }
  ]
}
```

**分派 + 统一出口**(进程内 service,**绝不自拼 HTTP 打 app**)

```go
func (p Provider) runReferenceList(ctx, invoke, in) (any, error) {
    ws := invoke.WorkspaceID
    switch in.Source {
    case "app":
        // AppCenterService 是到 app 的唯一出口(picker 同款);层级结果在 daemon 侧递归拍平
        return p.collectAppFiles(ctx, ws, in.ID /*appId*/, in.GroupID /*groupId*/, in.Query)
    case "task":
        if in.GroupID != "" { // 指定 issue
            d, _ := p.issues.GetIssueDetail(ctx, ws, in.GroupID)
            return mapOutputs(d.LatestOutputs)
        }
        hits, _ := p.issues.SearchIssueOutputs(ctx,
            RunOutputSearchParams{WorkspaceID: ws, TopicID: in.ID, Query: in.Query}) // 整个 topic
        return mapHits(hits)
    }
}
// collectAppFiles: p.appCenter.ListReferences(ws, appId, {ParentGroupID:groupId, Kinds:["file"], ...})
//   → group 递归、reference 收集、cursor 翻页、按 path 去重
```

**出口汇合图**

```
picker(renderer):  tuttidClient.listWorkspaceAppReferences ─HTTP→ DaemonAPI.ListWorkspaceAppReferences
                                                                   └→ AppCenterService.ListReferences ─代理→ app
新 CLI(agent):     tutti reference list ─HTTP→ daemon CLI invoke → references provider.handler
                                                                   └→ AppCenterService.ListReferences ─代理→ app(同一出口)
```

**wiring** —— `services/tuttid/wiring.go`(CLI providers 列表加一行,service 实例已就位)

```go
referencescli.NewProvider(workspaceService, appCenterService, issueService),
```

### 3.3 Layer ③ — skill + 路由

**`services/tuttid/service/agentsidecar/skill_templates/reference.md`**

```markdown
---
name: reference
description: Use for `mention://workspace-reference/<id>?source=...&workspaceId=...` links — resolve a referenced app/task artifact set into files to read as context. Reach tutti-cli for CLI syntax only.
---

# Reference

Use when the current user turn contains one or more
`mention://workspace-reference/<id>?source=...&workspaceId=...` links. This skill resolves a
reference handle into its artifact files so you can read them as context. Use the injected
`tutti-cli` skill as the command reference.

## Mention Contract

Treat the `mention://workspace-reference/...` link as the machine-readable source of truth. Parse:

- URL path: the entity id — `appId` when `source=app`, `topicId` when `source=task`.
- `source`: one of `app`, `task`.
- `workspaceId`: required scope.
- `groupId`: optional sub-scope — an app group when `source=app`, an `issueId` when `source=task`.
  Absent means the whole app / the whole topic.

Do not infer the file set from the mention label.

## Resolve

Run exactly one command to list the referenced files:

`{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`

The JSON result is `{ "items": [ { "path", "displayName", "sizeBytes", "mediaType" } ] }`,
already flattened. Then read the paths you need with your normal file tools.

## Invocation Rules

- This is a passive reference: list and read only.
- Do NOT open/complete issue runs, do NOT break down issues, do NOT mutate Tutti state, and do
  NOT invoke app commands — even when `source=task`. If the user separately asks to execute or
  break down an issue, switch to the `issue-manager` skill.
- If the result has zero items, say the reference currently has no artifacts instead of guessing.
- Read only the files relevant to the request; do not dump every file.
```

**通用路由** —— `policy_templates/tutti-runtime.md`(所有 provider 生效,加两行)

```
- If the current user turn contains `mention://workspace-reference/<id>?source=...&workspaceId=...`, route it to `reference`.
- For `mention://workspace-reference/<id>?source=...&workspaceId=...`, parse the path id plus `source`, `workspaceId`, `groupId`; list files with `{{CLI_COMMAND}} reference list --source <source> --id <id> [--group-id <groupId>] --json`, then read the returned paths.
```

**claude-code 强化** —— `tutti_cli_policy.go` `providerSpecificMentionRouting`(加一条)

```
- If the current user turn contains `mention://workspace-reference/<id>?source=...&workspaceId=...`, your first tool call MUST be `Skill(skill="reference", args="<full mention URI>")`. Do not call Bash, Read, ls, WebFetch, browser, MCP lookup, file search, or raw CLI commands before this skill call.
```

**skill 注册触点** —— `provider_skill.go`(name 常量 + render 函数 + 注入集合);`claude.go` plugin 打包(如需 namespaced `tutti-cli:reference`)。

---

## 4. 要移除的现有设计代码

本设计**推翻** [`agent-reference-source-services.md`](./agent-reference-source-services.md) 里「插入产物统一为文件路径,composer / 序列化 / agent 零改动」这一假设在 **bundle 引用** 上的实现。注意:`§3.5 resolveSelection → { path }` 对**松散单文件**仍成立;被移除的是其上叠加的 **bundle 展开机制**。逐项:

| #   | 移除/替换对象                                                                                                                                                                                                        | 位置                                                                                                                     | 处理                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **agent 模式 bundle 展开**:`formatAgentMentionMarkdown(item,"agent")` 把 `workspace-app-bundle` 炸成多条 `@path`                                                                                                     | `agentRichText/agentFileMentionExtension.ts`                                                                             | 删除 agent 分支的展开;reference 单链接直出                                                                                              |
| 2   | **递归枚举**:`confirmGrouped` 对 navigable 文件夹调 `collectFolderFiles`                                                                                                                                             | `react/internal/reference/referenceSourcePickerController.ts`                                                            | 从 bundle 路径移除;count 改用节点 `childCount`,**确认即时**。`collectFolderFiles` 若 `confirm()`(非分组路径)仍依赖则保留函数,否则一并删 |
| 3   | **files 夹带**:`buildAgentWorkspaceAppBundleMentionHref` 把文件路径 JSON 编进 `files=` + `decodeBundleFilesParam` 往返还原                                                                                           | `agentRichText/agentFileMentionExtension.ts`                                                                             | 删除 files/icon 编码与解码;`workspace-reference` URI 只带可解析 id + scope                                                              |
| 4   | **`workspace-app-bundle` mention kind**:扩展/展示/解析多处分支                                                                                                                                                       | `agentFileMentionExtension.ts` / `AgentMentionNodeView.tsx` / `shared/AgentMessageMarkdown.tsx` / `normalizeMentionKind` | 替换为 `workspace-reference`(或保留 kind 名但去展开——本设计取**替换**,统一命名)                                                         |
| 5   | **bundle item 的 files 字段及其装配**:`AgentMentionWorkspaceAppBundleItem.files`、`confirmWorkspaceReferenceBundles` 里 `bundle.files.map(...)`                                                                      | `AgentGUINodeView.tsx` / mention item 类型                                                                               | 去掉 files 字段,改建带句柄的 `workspace-reference` item                                                                                 |
| 6   | **双 prompt 序列化机制**(仅为 bundle 展开而存在):`AgentMentionSerializeMode = "display"\|"agent"`、`getAgentExpandedText()`、`AgentComposer` 里 `hasBundleExpansion` / `onSubmit(submitContent, displayPrompt)` 双串 | `agentRichTextDocument.ts` / `AgentRichTextEditor.tsx` / `AgentComposer.tsx`                                             | bundle 不再展开后,agent 串 == display 串,这套双串逻辑对引用失效,可整体下线(确认无其它消费者后删除)                                      |

> 移除顺序建议:**先上新链路(§5 步骤 1–3)跑通,再删旧机制(本节)**,避免中途两套并存导致序列化歧义。

---

## 5. 落地顺序

1. **CLI provider + `reference list`**(可独立写测、不依赖前端)→ 先打通 `tutti reference list` 对 app / task 都出正确扁平文件列表(统一出口)。
2. **skill + 路由 + 注册**(daemon 侧)→ agent 能被正确路由到 `reference` skill 并解析。
3. **前端句柄解码 + 序列化改造**(picker / composer)→ `describeReferenceHandle`、`workspace-reference` mention、不展开。
4. **移除旧 bundle 展开机制**(§4)。
5. 回归:大产物确认即时性、空引用(0 items)、topic 级引用、app 多层分组、非 claude-code provider。

---

## 6. 行为变化与风险

- **快照 → 实时**:agent 执行时才列文件——新增产出可见,发送后被删的也会变。属预期改进。
- **count 口径**:display 用 `childCount`(issue=`latestOutputs.length`,精确;app group=app 自报 `referenceCount`),不再是递归深数;深层文件夹显示的是直接子级数,属可接受的显示差异。
- **provider 覆盖**:路由加在通用层 `tutti-runtime.md`,非 claude-code provider 不 regress。
- **app 递归**:层级拍平从前端(旧 `collectFolderFiles`)移到 daemon 侧 `collectAppFiles`,更合理。
- **CLI 可达性**:依赖 agent 能执行 `tutti` CLI——与现有 `issue-manager` 等 skill 同一机制,已被现网验证。
