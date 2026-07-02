# Agent 文件引用源服务架构(Reference Source Services)

状态:设计定稿(待实现)
适用面:AgentGui composer 左下角「+」打开的 `WorkspaceFileReferencePicker` 弹窗
范围:本期只做 `+` picker;接口设计为将来可复用到 `@` mention palette

> 增补:**选中之后发送给 agent 的产物解析**已另立设计,见 [`agent-reference-mention-resolution.md`](./agent-reference-mention-resolution.md)。该文把「§3.5 / §4.5 选中即把全部文件路径展开塞进 prompt」改为「发一条 `workspace-reference` mention,由 skill 驱动 agent 调 `tutti reference list` 按需解析」。读到本文「composer / 序列化 / agent 零改动」时,bundle 引用一支以增补文为准。

---

## 0. 背景与目标

「+」弹窗当前只能浏览**本地文件**(workspace 文件树),数据源单一,由 `WorkspaceFileReferenceAdapter`(基于 path 的单根树)驱动。

未来要在同一个弹窗里支持多种来源:

1. **本地文件**(workspace files)— 已有
2. **应用内产物**(app artifacts,经 `listWorkspaceAppReferences`)— 本期新增
3. **任务中心产物**(task center artifacts)— 将来

逻辑上这些是**不同的源,每个一个 service**。本设计把弹窗从"单一数据源"升级为"可插拔的源服务层"。

### 已锁定的决策

| 决策               | 结论                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一键             | **`NodeRef { sourceId, nodeId }`** 不透明句柄;picker 不解析 nodeId。本地源 `nodeId = path`                                                                                                     |
| 源边界             | **各源自治**(取数 / open / open-with / reveal / preview 各自负责)+ **共享 base 工具层**(形状处理,非文件系统调用)                                                                               |
| 范围               | 只做 `+` picker;不动 `@` palette 的 `AgentRichTextAtProvider`,但接口设计为将来可复用                                                                                                           |
| 本地文件(回归防护) | 目标是**改造不引入 bug**:本地源 1:1 包装现有 adapter、行为逐项保持;唯一变化是 picker 树 key 从 path-keyed → node-keyed                                                                         |
| open / preview     | 应用产物**复用本地文件同一条 host 链路**(解析路径在 `~/.tutti` 内,过 homedir 校验),无新增 daemon 通道                                                                                          |
| 插入产物           | **统一为文件路径**(与现有 picker 一致),不引入新 kind,composer / 序列化 / agent 零改动                                                                                                          |
| UI 形态            | **顶部分源 tab**:每个可用源一个 tab,切 tab 切源;选中集跨 tab 累积,确认一并插入                                                                                                                 |
| 条件布局           | 由 `capabilities` 驱动:`navigable`=是否显示左侧分组导航,`typeFilterable`=是否显示类型筛选。本地源 false/false(简版),应用源 true/true(全版)。扩展信息(产出来源/时间/大小/面包屑/下载)所有源都有 |

---

## 1. 整体架构设计

### 1.1 分层

```
┌─────────────────────────────────────────────────────────┐
│ UI 层  WorkspaceFileReferencePicker (共享包,node-keyed) │
│   - 树渲染 / 展开 / 搜索 / 预览面板 / 多选确认            │
│   - 不认识具体源,只面对聚合器                            │
└───────────────┬─────────────────────────────────────────┘
                │ NodeRef / ReferenceNode
┌───────────────▼─────────────────────────────────────────┐
│ 聚合层  ReferenceSourceRegistry + Aggregator             │
│   - 根层级 = 每个可用源一个 folder 节点                  │
│   - 按 node.ref.sourceId 委派                            │
└───────────────┬─────────────────────────────────────────┘
                │ ReferenceSourceService
   ┌────────────┼───────────────┬──────────────────┐
   ▼            ▼               ▼
本地文件源    应用产物源       任务产物源(将来)
(包现有     (包 daemon       (包任务中心 API)
 adapter)    references)
   │            │               │
   ▼            ▼               ▼
host openFile  host openFile   任务通道
/ 预览(同一条 host 链路)
            ┌──────────────────────────────┐
            │ 共享 base 工具(各源复用)    │
            │ kind 映射 / 排序去重 /        │
            │ 预览类型判定 / cursor 累积 /  │
            │ nodeKey 归一                  │
            └──────────────────────────────┘
```

### 1.2 组件职责

| 组件                           | 职责                                                                         | 位置(建议)                                |
| ------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------- |
| `WorkspaceFileReferencePicker` | 树/搜索/预览/多选 UI;node-keyed 状态;导航栈                                  | `packages/workspace/file-reference`(改造) |
| `ReferenceSourceRegistry`      | 收集、过滤(`isAvailable`)、排序源                                            | 共享契约 + desktop DI                     |
| Aggregator                     | 根=源列表;按 sourceId 委派 listChildren/search/open/open-with/reveal/preview | 共享                                      |
| `ReferenceSourceService`       | 单源契约(各源自治)                                                           | 契约共享,实现分散                         |
| 本地文件源                     | 1:1 包装现有 `WorkspaceFileReferenceAdapter`                                 | `apps/desktop`                            |
| 应用产物源                     | 包 `tuttidClient.listWorkspaceAppReferences`;open/preview 复用 host 链路     | `apps/desktop`                            |
| 共享 base 工具                 | 形状处理(非取数)                                                             | 共享                                      |

### 1.3 包边界与依赖

- **契约 + 聚合 + base 工具 + picker UI** → 放在 `@tutti-os/workspace-file-reference`(UI 无关部分在 `core`/`contracts`,UI 在 `ui`)。
- **各源实现** → `apps/desktop`(依赖 `tuttidClient` / `hostFilesApi`),通过 DI 注册进 registry。
- AgentGui(`@tutti-os/agent-gui`)只通过 `AgentGUINodeView` 的 prop 接收聚合后的能力,**不感知具体源**。
- File Manager 通过 `external` location 扩展槽消费应用/任务产物源:左栏 location 由 desktop 从 `ReferenceSourceAggregator` 的根分组生成,右侧内容使用嵌入式 reference explorer 渲染。`@tutti-os/workspace-file-manager` 不得反向依赖 `@tutti-os/workspace-file-reference`,因为 reference 包已复用 file-manager 的图标、排序、open-with 和预览类型。

### 1.4 本地文件:回归防护(避免改造引入 bug)

> 这里**不是对外的"向后兼容"诉求**(同一套代码、同一批用户,无外部契约)。目标是:把本地文件接入新抽象的过程中,**不破坏现在能正常工作的功能**。因此本地源严格 1:1 包装现有逻辑、行为逐项保持,把回归面压到最小。

- daemon / tuttid client / host openFile / homedir 校验:**0 改动**。
- 取数映射、插入序列化产物:**逐字段保持一致**(改了就会让已存在的草稿/会话引用出错,属典型回归点)。
- 唯一变化:picker 内部树 key 从 `path` → `sourceId:nodeId`;本地源 `nodeId=path`,等价于加前缀 `workspace-file:`,**行为不变**。
- 父节点推导从"path 字符串运算"改为"导航栈记录",行为一致、实现替换——此处是回归高风险点,需测试覆盖。

---

## 2. 领域模型(Domain Model)

### 2.1 概念地图

```
                       ReferenceScope (workspaceId)
                                │ 上下文贯穿所有操作
                                ▼
   ReferenceSourceRegistry ──*── ReferenceSource «聚合根»
                                   │ metadata / capabilities
                                   │ 拥有一个节点命名空间
                                   │ 1
                                   │ ──────────────┐
                                   ▼ *             │ resolveSelection
                              ReferenceNode «实体» │
                                 │ identity            ▼
                                 ▼               SelectedReference «值对象»
                            NodeRef «值对象»          { path, kind }
                          { sourceId, nodeId }

   picker 侧浏览态:
   BrowseSession «实体» ── 持有 ─→ NodeRef 栈(导航路径)
        │
        └── 缓存 ─→ NodeChildrenState «值对象»  // 每个 folder 一份
                     { entries[], nextCursor, status }
```

### 2.2 实体与值对象

| 概念                                    | 类型             | 定义与职责                                                                                                                                                                                               | 生命周期 / 标识                                               |
| --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **ReferenceSource**                     | 聚合根(服务)     | 一个文件来源的边界。拥有自己的节点命名空间;声明 `metadata`(身份/排序)与 `capabilities`(可搜/可预览/可分页);对外暴露 browse / search / open / open-with / reveal / preview / resolveSelection。各源自治。 | 注册即存在;`isAvailable(scope)` 决定在某 workspace 下是否激活 |
| **NodeRef**                             | 值对象           | 节点的全局身份 `{ sourceId, nodeId }`。不可变,按值相等。`nodeId` 对 picker **不透明**,只有所属源能解释。                                                                                                 | 无独立生命周期;随节点产生                                     |
| **ReferenceNode**                       | 实体             | 树中一个节点,身份 = `NodeRef`。`kind: folder \| file`,携带展示名与文件元数据。folder 可有子节点,file 不可。                                                                                              | 由源在 `listChildren` 时产出;源内身份须稳定                   |
| **ReferenceScope**                      | 值对象           | `{ workspaceId }`,所有源操作的上下文。                                                                                                                                                                   | —                                                             |
| **SelectedReference**                   | 值对象           | 选中后插入 composer 的产物,**统一形态** `{ path, kind, displayName }`。各源 `resolveSelection` 归一到此。                                                                                                | 插入即固化进草稿/会话                                         |
| **ReferencePreview**                    | 值对象           | 预览内容 `{ bytes, contentType, kind }`。                                                                                                                                                                | 瞬时                                                          |
| **BrowseSession / NavigationStack**     | 实体(UI 态)      | 当前浏览位置 = 一个 `NodeRef` 栈;空栈 = 根(展示源列表)。下钻 push,返回 pop。                                                                                                                             | 随弹窗打开创建,关闭销毁                                       |
| **NodeChildrenState**                   | 值对象(局部状态) | 某 folder 的子节点缓存 `{ entries[], nextCursor, status }`。以 `sourceId:nodeId` 为 key。                                                                                                                | 弹窗会话内缓存                                                |
| **SourceMetadata / SourceCapabilities** | 值对象           | 源的展示身份与能力开关,驱动 UI 取舍。                                                                                                                                                                    | 随源                                                          |

### 2.3 各源的领域映射

同一套领域概念,在三个源里的具体含义:

| 领域概念        | 本地文件源 `workspace-file`                  | 应用产物源 `app-artifact`                         | 任务产物源 `task-artifact`(将来) |
| --------------- | -------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| `nodeId` 含义   | 文件逻辑路径(`/workspace/...`)               | 编码 `appId` + 不透明 group 链(见 §4.6)           | 任务/产物 id                     |
| 根(`node=null`) | workspace root 目录                          | 支持 references 的 app 列表(每 app 一个 folder)   | 任务列表                         |
| folder          | 目录                                         | app 节点、group(项目)节点                         | 任务/分组节点                    |
| file            | 文件                                         | reference(`AppFileReference`,携带解析绝对路径)    | 产物文件                         |
| 分页            | 无(`nextCursor` 恒 null)                     | 有(references `cursor`)                           | 视后端                           |
| open / preview  | preview-first activation / `readPreviewFile` | **同一条 host 链路**(解析路径在 `~/.tutti`)       | 视后端                           |
| `isAvailable`   | 恒 true                                      | 存在任一 `references.listSupported===true` 的 app | 任务中心启用时                   |

### 2.4 不变式(Invariants)

1. `NodeRef.sourceId` 必须对应已注册源;否则该节点非法,聚合层拒绝委派。
2. **picker 不得解析 `nodeId`**——只整体持有、原样回传给源。任何"切 `/`、推父、拼接"都不允许出现在 picker。
3. `file` 节点无子节点;`folder` 节点用 `hasChildren` 表达可下钻。
4. 同一 `(source, node)` 的分页 `cursor` 单调推进,`listChildren` 续页是 **append** 语义,不重排已得项。
5. 对任意 node,`resolveSelection` 必产出统一 `SelectedReference`(`path` + `kind`),下游无需识别来源。
6. 源 `isAvailable=false` ⇒ 其任何节点不出现在树中(根层级即隐藏)。
7. 节点身份在源内**稳定**:同一逻辑文件多次 `listChildren` 得到相同 `nodeId`——这是去重与多选正确性的前提。

### 2.5 状态(Lifecycle)

```
NodeChildrenState:
  unloaded ──listChildren──▶ loading ──成功──▶ loaded(有 nextCursor = 部分)
                                              │
                              load more ◀─────┘
                                              └──nextCursor=null──▶ loaded(完整)

BrowseSession:
  根(空栈,展示源列表)
     │ 点 folder → push(node.ref)
     ▼
  某层(栈顶 = 当前 folder)
     │ 点「返回」/面包屑 → pop
     │ 输入关键字 → search 模式(覆盖当前层结果)
     │ 清空关键字 → 恢复 browse(导航栈不变)
```

---

## 3. 工作流程

### 3.1 打开弹窗(顶部分源 tab)

```
点「+」→ registry.getSources(scope)
       → 过滤 isAvailable + 按 order 排序
       → 顶部渲染一排 tab:每个可用源一个 tab
         (本地文件 / 应用产物 / 任务产物)
       → 默认选中 order 最小的 tab(本地文件),展示该源根层级树
```

> 若某源不可用(如无支持 references 的 app),其 tab 不出现。仅一个源时可隐藏 tab 栏。
> 每个 tab 维护各自的导航栈与树状态;切 tab 保留各自浏览位置。选中集跨 tab 累积。

### 3.2 浏览下钻(browse)

```
点某节点(folder)→ 压入导航栈 parent=node.ref
  → source.listChildren(scope, { node, cursor:null })   // 按 sourceId 委派
  → 渲染 entries;若 nextCursor != null → 显示「加载更多」
点「加载更多」→ source.listChildren(scope, { node, cursor })
  → append entries,更新 cursor
点「返回」/ 面包屑 → 弹栈,回上层 node
```

- picker **不解析 nodeId**:下钻就是把 `node.ref` 原样回传给源。
- 树状态以 `sourceId:nodeId` 为 key 缓存各层 entries 与 cursor。

### 3.3 搜索(search)

```
输入关键字 → 模式切到 search
  - 若聚焦在某源/某层:source.search(scope, { query, cursor })
  - 跨源全局搜索:本期不做(各源 capabilities.searchable 决定是否参与)
清空关键字 → 回 browse 模式,保留导航栈
```

### 3.4 预览 / 打开

```
选中文件节点 → 若 source.capabilities.previewable:
  source.readPreview(scope, node) → 右侧预览面板
双击 / 打开 → source.open(scope, node)
```

- 本地源:`open` 复用文件管理器的 preview-first activation 语义:先把文件解析为 `WorkspaceFileActivationTarget`,调用当前 workspace 注册的 Tutti canvas preview launcher;若格式不支持或 launcher 未处理,再 fallback 到 host `openFile`(系统默认应用)。`readPreview` 继续走 `readPreviewFile`(受 homedir 校验)。
- 应用产物源:**与本地文件走同一条 host 链路**。daemon 解析出的 app 文件绝对路径在 `~/.tutti/apps/workspaces/{ws}/{appId}/data/...` 下,落在 homedir 内,能通过 host 的 `isPathWithinRoot(homedir, …)` 校验;references OpenAPI 也明确这些路径"可当普通文件链接打开"。因此 `open/readPreview` 直接复用现有 `openReference/readReferencePreview`,传 `{ path: 解析绝对路径, kind:"file" }` 即可。`open` 保持文件管理器一致的 preview-first/fallback 语义,`capabilities.previewable = true`,无需新建 daemon 通道。
- 右键菜单的 `打开方式` 与 `在 Finder/文件管理器中显示` 也属于同一组 source 自治的 host 文件动作。picker 不解析 `nodeId` 或路径,只把 `ReferenceNode` 原样交给 aggregator;本地源、应用产物源、任务产物源各自通过 `WorkspaceFileReferenceAdapter` 复用 `listOpenWithApplications` / `openFileWithApplication` / `openFileWithOtherApplication` / `revealWorkspaceFile` 等 host 能力。

### 3.5 选中确认 → 插入 composer

```
多选确认 → 对每个选中 node:source.resolveSelection(node) → SelectedReference
        → picker.onConfirm(selected[])
        → composer.insertWorkspaceReferences(selected[])
```

- **所有源 `resolveSelection` 产出同一形态**(`{ path, kind, displayName }`,即"最终拿到一个文件路径"),与今天 picker 逐字段一致 → **composer / 序列化 / agent 侧零改动**。
- 应用产物的 `path` = daemon 解析出的绝对路径(在 `~/.tutti/...`),对下游就是普通文件路径,不引入新 kind(见 §4.5)。

### 3.6 应用产物源的具体流程

```
node=null(源根)→ listWorkspaceApps(ws) 过滤 references.listSupported
   → 每个 app 一个 folder 节点 nodeId="app:{appId}"
node=app 节点 → listWorkspaceAppReferences(ws, appId, {parentGroupId:null, cursor})
   → group 项 → folder 节点(childCount=referenceCount)
   → reference 项 → file 节点(携带解析后的绝对 path,仅源内部用)
node=group 节点 → listWorkspaceAppReferences(ws, appId, {parentGroupId:groupId, cursor})
filter(当前层)→ 作为 filterText 传入(协议规定只过滤直接子项)
```

---

## 4. 接口文档

> TypeScript 定义。放置:`@tutti-os/workspace-file-reference/contracts`(类型)与 `/core`(base 工具)。

### 4.1 核心类型

```ts
/** 不透明、源内作用域的节点句柄。picker 永不解析 nodeId。 */
export interface NodeRef {
  sourceId: string; // "workspace-file" | "app-artifact" | "task-artifact"
  nodeId: string; // 源内不透明;本地源 = path
}

/** 统一树节点 */
export interface ReferenceNode {
  ref: NodeRef;
  kind: "folder" | "file";
  displayName: string;
  hasChildren?: boolean; // folder 懒加载箭头
  childCount?: number | null; // 可选数量(app group 的 referenceCount)
  sizeBytes?: number | null;
  mtimeMs?: number | null;
  mimeType?: string | null;
}

export interface ReferenceScope {
  workspaceId: string;
}
```

### 4.2 浏览 / 搜索 / 预览

```ts
export interface ListChildrenInput {
  node: NodeRef | null; // null = 该源根层级
  cursor?: string | null; // 续页;本地源恒不返回
  filter?: string | null; // 当前层过滤(可选)
  signal?: AbortSignal;
}
export interface ListChildrenResult {
  entries: ReferenceNode[];
  nextCursor?: string | null;
}

export interface SearchInput {
  query: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}
export interface SearchResult {
  entries: ReferenceNode[];
  nextCursor?: string | null;
}

export type ReferencePreviewKind = "image" | "text";
export interface ReferencePreview {
  bytes: Uint8Array | ArrayBuffer;
  contentType?: string | null;
  kind: ReferencePreviewKind;
}
```

### 4.3 源服务契约

```ts
export interface ReferenceSourceMetadata {
  id: string;
  label: string;
  icon?: string;
  order: number;
}
export interface ReferenceSourceCapabilities {
  searchable: boolean;
  previewable: boolean;
  paginated: boolean;
}

export interface ReferenceSourceService {
  readonly metadata: ReferenceSourceMetadata;
  readonly capabilities: ReferenceSourceCapabilities;

  /** 动态可用性:无支持 references 的 app 时应用产物源返回 false。 */
  isAvailable(scope: ReferenceScope): boolean | Promise<boolean>;

  listChildren(
    scope: ReferenceScope,
    input: ListChildrenInput
  ): Promise<ListChildrenResult>;
  search?(scope: ReferenceScope, input: SearchInput): Promise<SearchResult>;

  open?(scope: ReferenceScope, node: ReferenceNode): Promise<void>;
  readPreview?(
    scope: ReferenceScope,
    node: ReferenceNode
  ): Promise<ReferencePreview | null>;

  /** 选中 → 插入 composer 的产物;统一形态,见 §4.5。 */
  resolveSelection(node: ReferenceNode): SelectedReference;
}
```

### 4.4 注册 / 聚合

```ts
export interface ReferenceSourceRegistry {
  /** 已按 isAvailable 过滤、按 metadata.order 排序。 */
  getSources(scope: ReferenceScope): Promise<ReferenceSourceService[]>;
}
```

聚合器行为(tab 模型):

- `listSources(scope)` → 返回可用源的 `{ sourceId, label, capabilities }`,用于渲染顶部 tab。
- 某 tab 激活时,以 `listChildren(scope, { sourceId, nodeId: SOURCE_ROOT })` 取该源根层级,其后下钻原样回传 node。
- `search / open / open-with / reveal / readPreview / resolveSelection` 均按 `node.ref.sourceId`(或当前 tab sourceId)委派。

### 4.5 插入产物(所有源统一为"文件路径",不引入多态)

**决策:与现有 picker 完全一致——最终都是拿到一个文件路径。** 不新增 insert kind,composer / 序列化 / agent 侧零改动。

```ts
/** 所有源(本地文件 / 应用产物 / 任务产物)统一产出现状形态 */
export interface SelectedReference {
  path: string; // 应用产物 = daemon 解析的绝对路径(~/.tutti/...);本地 = /workspace 逻辑路径
  kind: "file" | "folder";
  displayName?: string;
}
```

- 各源 `resolveSelection(node)` 把自己的 node 归一成这个形态;`path` 取自 node 内已解析好的文件路径。
- 对 composer / 下游 reference tracker / agent:**就是一条普通文件引用**,无需感知来源,无需改动。
- 已知取舍(不阻塞):持久化的是应用产物当时的解析绝对路径,app 重装/版本变更后该路径可能失效——与本地文件"路径被移动/删除即失效"性质相同,接受。

### 4.6 应用产物源:nodeId 编码与传输

nodeId 对 picker 不透明,由应用产物源自行编码/解码:

```
源根     : node = null
app 节点 : nodeId = "app:" + appId
group 节点: nodeId = "app:" + appId + "|grp:" + base64url(opaque groupId)
file 节点: nodeId = "app:" + appId + "|ref:" + base64url(location.path)
```

- 分隔符 `|`、前缀 `app:/grp:/ref:` 仅源内部使用;opaque groupId 走 base64url 避免特殊字符。
- 解码后映射到协议参数:`appId`、`parentGroupId`(= group 的 opaque id)、`cursor`(来自 `ListChildrenInput.cursor`)、`filterText`(= `filter`)。
- **open / preview**:**复用本地文件同一条 host 链路**。`open` 走 preview-first activation,先尝试 Tutti canvas preview,未处理再 fallback 到 `hostFilesApi.openFile`;`preview` 走 `readPreviewFile`。传入 daemon 解析出的绝对路径(在 `~/.tutti/...` 下,通过 homedir 校验)。`capabilities.previewable = true`,无需新建 daemon 通道。

### 4.7 约定

- **空结果**:`entries: []`,不抛错。
- **abort**:传入的 `signal` 中止后,实现应尽快返回空/抛 AbortError,聚合层吞掉。
- **分页**:`nextCursor == null/undefined` 表示无更多;本地源恒为 null。
- **能力降级**:`capabilities` 决定 UI 是否展示搜索框 / 预览面板 / 「加载更多」;源不可用时根层级隐藏。

---

## 5. 本期落地边界

- ✅ 做:契约 + 聚合 + base 工具 + picker node-keyed 改造 + 本地源(包装)+ 应用产物源(browse / 分页 / open / preview / 选中插入)。open/preview 与 insert 均复用本地文件链路,无新增 daemon 通道、无新增 insert kind。
- ❌ 不做:`@` palette 接入、跨源全局搜索、任务中心源(接口已留位)。

---

## 6. 待实现前对齐项(均已确认)

1. ~~应用产物 open/preview 的 daemon 中介通道是否本期提供~~ —— **不需要新通道**。app 数据在 `~/.tutti/...`(homedir 内),复用本地文件同一条 host 链路即可通过校验:`open` 为 preview-first activation + `openFile` fallback,`preview` 为 `readPreviewFile`;OpenAPI 亦明确这些绝对路径可当普通文件链接打开。`capabilities.previewable = true`。
2. ~~应用产物插入/序列化格式与 composer/agent 侧对齐~~ —— **与现有 picker 一致(统一为文件路径)**,不引入新 kind,composer/序列化/agent 零改动(§4.5)。
3. ~~`references.listSupported` 是否在 `listWorkspaceApps` 响应中返回~~ —— **有**。`listWorkspaceApps` → `WorkspaceAppListResponse.apps[].references.listSupported: boolean`(OpenAPI 3556 / types.gen.ts 418、304,均为必填)。应用产物源 `isAvailable` = 列表中存在任一 `listSupported === true`;根层级 app 列表 = 过滤 `listSupported === true` 的 app。无需额外探测调用。
