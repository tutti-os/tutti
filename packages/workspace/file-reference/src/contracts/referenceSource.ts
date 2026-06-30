import type {
  WorkspaceFileReferencePreview,
  WorkspaceFileReferenceScope
} from "./index.ts";
import type { WorkspaceFileOpenWithApplication } from "@tutti-os/workspace-file-manager/services";

/**
 * Reference Source Services 契约。
 *
 * 设计见 docs/architecture/agent-reference-source-services.md。
 * 把「+」文件引用弹窗从单一数据源升级为可插拔的多源服务层:
 * 本地文件 / 应用内产物 / 任务中心产物,每个一个 ReferenceSourceService。
 */

/**
 * 不透明、源内作用域的节点句柄。
 * picker 永不解析 nodeId —— 只整体持有、原样回传给所属源。
 */
export interface NodeRef {
  /** "workspace-file" | "app-artifact" | "task-artifact" ... */
  sourceId: string;
  /** 源内不透明标识。本地源 = path;应用产物源 = 编码后的 app/group/file 句柄。 */
  nodeId: string;
}

/** 统一树节点。identity = NodeRef。folder 可有子节点,file 不可。 */
export interface ReferenceNode {
  ref: NodeRef;
  kind: "folder" | "file";
  displayName: string;
  /**
   * 可选的「上下文标签」:搜索结果里展示该项的归属(如应用名 / 议题标题),
   * 替代不透明 nodeId 作为副标题。各源自行填充;本地源不填(回退展示 path)。
   */
  contextLabel?: string | null;
  /** folder 是否可下钻(懒加载箭头)。 */
  hasChildren?: boolean;
  /** 可选数量,如 app group 的 referenceCount。 */
  childCount?: number | null;
  /** 可选图标(data URL / 远程 URL),如应用产物源的 app 图标;有则替代默认文件夹图标。 */
  iconUrl?: string | null;
  createdTimeMs?: number | null;
  sizeBytes?: number | null;
  mtimeMs?: number | null;
  mimeType?: string | null;
}

/** 所有源操作的上下文。 */
export type ReferenceScope = WorkspaceFileReferenceScope;

export interface ListChildrenInput {
  /** null = 该源根层级。 */
  node: NodeRef | null;
  /** 续页游标;本地源恒不返回。 */
  cursor?: string | null;
  /** 当前层过滤(可选)。协议层只过滤直接子项,非递归。 */
  filter?: string | null;
  signal?: AbortSignal;
}

export interface ListChildrenResult {
  entries: ReferenceNode[];
  /** null/undefined 表示无更多。 */
  nextCursor?: string | null;
  /**
   * 源已自行排序、picker 不应再重排时置 true(如「最近访问」按访问时间倒序)。
   * 缺省/false:picker 首屏按 folder 在前 + 名称排序。
   */
  ordered?: boolean;
}

export interface SearchInput {
  query: string;
  /**
   * 已选「文件类型筛选分类」id 数组(全局统一口径,见 core/referenceFilterCategories)。
   * 筛选与搜索在底层是同一能力:query 可空、filters 非空时即「仅按类型查」。
   * 空数组/缺省 = 不按类型过滤。各源把它下钻到 daemon 真正过滤。
   */
  filters?: string[];
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  /**
   * 可选:把搜索限定在该源内某个二级分组(左栏选中的「分组节点」nodeId,源内不透明)。
   * 缺省/null = 跨整源搜索(历史行为)。例如应用产物源传入选中 app 的分组节点,
   * 即「只搜该应用」而非所有应用。源自行解释此 nodeId;不支持的源可忽略。
   */
  withinNodeId?: string | null;
}

export interface SearchResult {
  entries: ReferenceNode[];
  nextCursor?: string | null;
}

/** 预览内容(复用 workspace 预览结构)。 */
export type ReferencePreview = WorkspaceFileReferencePreview;

/**
 * 选中的「分组节点」归一成的可被 agent 解析的引用句柄。
 * 与发给 agent 的 `mention://workspace-reference/<id>?source=...` 一一对应:
 *  - app:  { source:"app",  id: appId,   groupId? }(groupId = app 子分组)
 *  - task: { source:"task", id: topicId, groupId? }(groupId = issueId;缺省 = 整个 topic)
 * 各源把自家不透明 nodeId 解码成此领域句柄;picker 自身不解析。
 */
export interface ReferenceHandle {
  source: "app" | "task";
  /** 顶层容器 id:appId / topicId。 */
  id: string;
  /** 子级 id:app 子分组 / issueId。缺省表示整个容器。 */
  groupId?: string;
}

/**
 * 「定位到某分组」目标:打开 picker 时直达某事项/应用分组用。
 * params 为源内不透明语义参数,由各源 backend 自行解释:
 *  - 应用产物源:{ appId }
 *  - 议题产出源:{ issueId, topicId? }
 */
export interface ReferenceLocateTarget {
  /** 目标所属源(= picker tab / ReferenceSourceService.metadata.id)。 */
  sourceId: string;
  params: Record<string, string>;
}

/**
 * 选中 → 插入 composer 的产物。
 * 统一形态:所有源最终都归一为一个文件路径,与现有 picker 逐字段一致,
 * composer / 序列化 / agent 侧零改动。
 */
export interface SelectedReference {
  /** 应用产物 = daemon 解析的绝对路径;本地 = /workspace 逻辑路径。 */
  path: string;
  kind: "file" | "folder";
  displayName?: string;
  /** Host-local original path, when path is an opaque transfer handle. */
  hostPath?: string;
  /** 保留引用来源,供上层区分 workspace 文件与 host 本地文件等同形 path。 */
  sourceId?: string;
}

export interface ReferenceSourceMetadata {
  id: string;
  label: string;
  icon?: string;
  /** 根层级排序,小者在前。 */
  order: number;
}

export interface ReferenceSourceCapabilities {
  searchable: boolean;
  previewable: boolean;
  paginated: boolean;
  /** 是否展示左侧分组导航(master-detail)。本地源 false;应用/任务源 true。 */
  navigable?: boolean;
  /**
   * 是否支持「全局文件类型筛选」(图片/文档/表格…)。为 true 时 picker 展示筛选下拉,
   * 已选分类作为 search() 的 filters 下钻到 daemon 过滤。三源(本地/应用/任务)均为 true。
   */
  filterable?: boolean;
}

/**
 * 单源契约。各源自治:取数 / open / preview 各自负责。
 * 形状处理(kind 映射、排序去重、预览类型、cursor 累积、nodeKey 归一)走共享 base 工具。
 */
export interface ReferenceSourceService {
  readonly metadata: ReferenceSourceMetadata;
  readonly capabilities: ReferenceSourceCapabilities;

  /** 动态可用性。如:无支持 references 的 app 时应用产物源返回 false。 */
  isAvailable(scope: ReferenceScope): boolean | Promise<boolean>;

  /**
   * 可选:源自带的左栏二级分组(固定「位置」),返回顺序即展示顺序。
   * 返回时 picker 直接用这些节点作为二级分组,不再从源根推导。
   * 缺省:picker 取源根下的 folder 作为分组(navigable 源默认行为)。
   */
  listSidebarGroups?(scope: ReferenceScope): ReferenceNode[];

  listChildren(
    scope: ReferenceScope,
    input: ListChildrenInput
  ): Promise<ListChildrenResult>;

  /**
   * 可选:把语义定位参数解析为从源根到目标分组的 NodeRef 路径(root → leaf),
   * 供 picker 打开时逐层展开/聚焦。返回 null 表示不支持或未找到。
   */
  locateTarget?(
    scope: ReferenceScope,
    params: Record<string, string>
  ): Promise<NodeRef[] | null>;

  /**
   * 可选:把一个「分组节点」解码成可被 agent 解析的领域句柄(见 ReferenceHandle)。
   * navigable 源(app/task)实现;返回 null 表示该节点不是可引用的分组。
   * 用于把选中的文件夹折叠成一条 `mention://workspace-reference/...`,而非展开成文件路径。
   */
  describeReferenceHandle?(node: ReferenceNode): ReferenceHandle | null;

  search?(scope: ReferenceScope, input: SearchInput): Promise<SearchResult>;

  open?(scope: ReferenceScope, node: ReferenceNode): Promise<void>;
  listOpenWithApplications?(
    scope: ReferenceScope,
    node: ReferenceNode
  ): Promise<WorkspaceFileOpenWithApplication[]>;
  openWithApplication?(
    scope: ReferenceScope,
    node: ReferenceNode,
    applicationPath: string
  ): Promise<void>;
  openWithOtherApplication?(
    scope: ReferenceScope,
    node: ReferenceNode,
    applicationPickerPrompt?: string
  ): Promise<void>;
  reveal?(scope: ReferenceScope, node: ReferenceNode): Promise<void>;
  readPreview?(
    scope: ReferenceScope,
    node: ReferenceNode
  ): Promise<ReferencePreview | null>;

  /** 选中产物归一,见 SelectedReference。 */
  resolveSelection(node: ReferenceNode): SelectedReference;
}

export interface ReferenceSourceRegistry {
  /** 已按 isAvailable 过滤、按 metadata.order 排序。 */
  getSources(scope: ReferenceScope): Promise<ReferenceSourceService[]>;
}
