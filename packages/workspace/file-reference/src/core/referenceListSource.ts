import type {
  ListChildrenResult,
  NodeRef,
  ReferenceHandle,
  ReferenceNode,
  ReferencePreview,
  ReferenceScope,
  ReferenceSourceCapabilities,
  ReferenceSourceService,
  SearchInput,
  SearchResult,
  SelectedReference
} from "../contracts/referenceSource.ts";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter
} from "../contracts/index.ts";

/**
 * 统一的「引用列表协议」—— 与 app references 同一套 group/reference/parentGroupId/cursor 形状。
 * 各源(应用 / issue / 任务…)各自实现一个 ReferenceListBackend 把自家数据映射成此协议;
 * createReferenceListSource 把协议 item 映射成 ReferenceNode,各源前端逻辑完全复用。
 * 当前架构见 docs/architecture/agent-reference-sources.md。
 */

export interface ReferenceListGroup {
  type: "group";
  /** 不透明分组 id;作为下钻的 parentGroupId 原样回传。 */
  id: string;
  displayName: string;
  /** 可选的展示上下文,用于详情/搜索副标题,避免 UI 泄露不透明 group id。 */
  parentLabel?: string | null;
  referenceCount?: number | null;
  /** 可选分组图标(data URL / 远程 URL),如应用产物源的 app 图标。 */
  iconUrl?: string | null;
}

export interface ReferenceListFile {
  /** daemon/host 可解析的文件路径。 */
  path: string;
  displayName?: string | null;
  /**
   * 可选的归属标签(如应用名 / 议题标题),用于搜索结果副标题。
   * 各源在「跨整源搜索拍平」时填入父级上下文;不填则不展示副标题。
   */
  parentLabel?: string | null;
  createdTimeMs?: number | null;
  sizeBytes?: number | null;
  mtimeMs?: number | null;
  mimeType?: string | null;
}

export interface ReferenceListReference {
  type: "reference";
  reference: ReferenceListFile;
}

export type ReferenceListItem = ReferenceListGroup | ReferenceListReference;

export interface ReferenceListRequest {
  /** null = 根层级。 */
  parentGroupId: string | null;
  cursor?: string | null;
  filter?: string | null;
  signal?: AbortSignal;
}

export interface ReferenceListResult {
  items: ReferenceListItem[];
  nextCursor?: string | null;
}

/** 递归搜索请求(跨整源,非当前层 filter)。 */
export interface ReferenceListSearchRequest {
  query: string;
  /** 结果类型约束,backend 必须在分页/limit 前执行。 */
  kinds?: Array<ReferenceNode["kind"]>;
  /** 已选文件类型筛选分类 id(全局统一口径);空数组/缺省 = 不按类型过滤。 */
  filters?: string[];
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
  /**
   * 可选:把搜索限定在某个分组下(协议层不透明 group id,与 list 返回的 group.id 同形)。
   * 缺省/null = 跨整源搜索。由 createReferenceListSource 从 SearchInput.withinNodeId 解码而来。
   */
  withinGroupId?: string | null;
}

/** 各源自治的取数适配器:把自家数据映射成统一协议。 */
export interface ReferenceListBackend {
  list(
    scope: ReferenceScope,
    request: ReferenceListRequest
  ): Promise<ReferenceListResult>;
  /**
   * 可选:递归搜索。实现即代表该源支持全局搜索(对应 capabilities.searchable)。
   * 返回 flat reference items(协议层不返回 group)。
   */
  search?(
    scope: ReferenceScope,
    request: ReferenceListSearchRequest
  ): Promise<ReferenceListResult>;
  /**
   * 可选:把语义定位参数解析为从根到目标分组的「不透明分组 id」路径(root → leaf),
   * 用各源自家的 group id 方案(与 list 返回的 group.id 同形),wrapper 负责编成 NodeRef。
   * 返回 null 表示不支持或未找到。
   */
  locate?(
    scope: ReferenceScope,
    params: Record<string, string>
  ): Promise<string[] | null>;
  /**
   * 可选:把自家「不透明分组 id」解码成可被 agent 解析的领域句柄(见 ReferenceHandle)。
   * navigable 源实现;wrapper 负责先剥掉 GROUP_PREFIX 再调本方法。
   */
  describeHandle?(groupId: string): ReferenceHandle | null;
}

export interface CreateReferenceListSourceInput {
  sourceId: string;
  label: string;
  order?: number;
  /** 可选源图标令牌(如 "issue"),供 picker 决定二级分组的兜底图标。 */
  icon?: string;
  capabilities: ReferenceSourceCapabilities;
  isAvailable: (scope: ReferenceScope) => boolean | Promise<boolean>;
  backend: ReferenceListBackend;
  /** 保留 backend.list 返回的数组顺序，禁止 picker 按名称重新排序。 */
  preserveBackendOrder?: boolean;
  /** open/preview 复用 host 链路(协议返回的 path 可被解析打开)。 */
  adapter: WorkspaceFileReferenceAdapter;
}

const GROUP_PREFIX = "g:";
const FILE_PREFIX = "f:";

export function createReferenceListSource(
  input: CreateReferenceListSourceInput
): ReferenceSourceService {
  const { sourceId, label, capabilities, isAvailable, backend, adapter } =
    input;

  function fileReferenceOf(node: ReferenceNode): WorkspaceFileReference {
    if (node.kind === "folder") {
      return {
        path: decodeSegment(GROUP_PREFIX, node.ref.nodeId),
        kind: "folder"
      };
    }
    return { path: decodeSegment(FILE_PREFIX, node.ref.nodeId), kind: "file" };
  }

  const service: ReferenceSourceService = {
    metadata: {
      id: sourceId,
      label,
      order: input.order ?? 0,
      ...(input.icon ? { icon: input.icon } : {})
    },
    capabilities,
    isAvailable,

    async listChildren(
      scope: ReferenceScope,
      { node, cursor, filter }
    ): Promise<ListChildrenResult> {
      // file 节点没有子节点。
      if (node && node.nodeId.startsWith(FILE_PREFIX)) {
        return { entries: [], nextCursor: null };
      }
      const parentGroupId = node
        ? decodeSegment(GROUP_PREFIX, node.nodeId)
        : null;
      const result = await backend.list(scope, {
        parentGroupId,
        cursor: cursor ?? null,
        filter: filter ?? null
      });
      return {
        entries: result.items.map((item) => itemToNode(sourceId, item)),
        nextCursor: result.nextCursor ?? null,
        ...(input.preserveBackendOrder ? { ordered: true } : {})
      };
    },

    async open(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.openReference?.(fileReferenceOf(node));
    },

    async listOpenWithApplications(
      _scope: ReferenceScope,
      node: ReferenceNode
    ) {
      return (
        (await adapter.listOpenWithApplications?.(fileReferenceOf(node))) ?? []
      );
    },

    async openWithApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPath: string
    ): Promise<void> {
      await adapter.openReferenceWithApplication?.(
        fileReferenceOf(node),
        applicationPath
      );
    },

    async openWithOtherApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPickerPrompt?: string
    ): Promise<void> {
      await adapter.openReferenceWithOtherApplication?.(
        fileReferenceOf(node),
        applicationPickerPrompt
      );
    },

    async reveal(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.revealReference?.(fileReferenceOf(node));
    },

    async readPreview(
      scope: ReferenceScope,
      node: ReferenceNode
    ): Promise<ReferencePreview | null> {
      if (!adapter.readReferencePreview) {
        return null;
      }
      return adapter.readReferencePreview({
        workspaceId: scope.workspaceId,
        reference: fileReferenceOf(node)
      });
    },

    resolveSelection(node: ReferenceNode): SelectedReference {
      const reference = fileReferenceOf(node);
      return {
        path: reference.path,
        kind: reference.kind === "folder" ? "folder" : "file",
        ...(node.displayName ? { displayName: node.displayName } : {})
      };
    }
  };

  // 仅当 backend 实现了定位时才暴露 locateTarget;把不透明分组 id 路径编成 NodeRef 路径。
  const backendLocate = backend.locate?.bind(backend);
  if (backendLocate) {
    service.locateTarget = async (
      scope: ReferenceScope,
      params: Record<string, string>
    ): Promise<NodeRef[] | null> => {
      const groupIds = await backendLocate(scope, params);
      if (!groupIds) {
        return null;
      }
      return groupIds.map((groupId) => ({
        sourceId,
        nodeId: GROUP_PREFIX + base64UrlEncode(groupId)
      }));
    };
  }

  // 仅当 backend 实现了句柄解码时才暴露 describeReferenceHandle:剥掉 GROUP_PREFIX
  // 得到 backend 自家分组 id,交给 backend 解码成领域句柄。非分组节点(文件/源根)→ null。
  const backendDescribeHandle = backend.describeHandle?.bind(backend);
  if (backendDescribeHandle) {
    service.describeReferenceHandle = (
      node: ReferenceNode
    ): ReferenceHandle | null => {
      if (!node.ref.nodeId.startsWith(GROUP_PREFIX)) {
        return null;
      }
      return backendDescribeHandle(
        decodeSegment(GROUP_PREFIX, node.ref.nodeId)
      );
    };
  }

  // 仅当 backend 实现了递归搜索时才暴露 search,与 capabilities.searchable 保持一致。
  const backendSearch = backend.search?.bind(backend);
  if (backendSearch) {
    service.search = async (
      scope: ReferenceScope,
      input: SearchInput
    ): Promise<SearchResult> => {
      // 把左栏选中的分组节点(GROUP_PREFIX nodeId)解码成协议层不透明 group id;
      // 非分组(源根 / 文件节点 / 缺省)→ null,退回跨整源搜索。
      const withinGroupId =
        input.withinNodeId && input.withinNodeId.startsWith(GROUP_PREFIX)
          ? decodeSegment(GROUP_PREFIX, input.withinNodeId)
          : null;
      const result = await backendSearch(scope, {
        query: input.query,
        cursor: input.cursor ?? null,
        ...(input.kinds && input.kinds.length > 0
          ? { kinds: input.kinds }
          : {}),
        ...(input.filters && input.filters.length > 0
          ? { filters: input.filters }
          : {}),
        ...(input.limit == null ? {} : { limit: input.limit }),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(withinGroupId == null ? {} : { withinGroupId })
      });
      return {
        entries: result.items.map((item) => itemToNode(sourceId, item)),
        nextCursor: result.nextCursor ?? null
      };
    };
  }

  return service;
}

function itemToNode(sourceId: string, item: ReferenceListItem): ReferenceNode {
  if (item.type === "group") {
    return {
      ref: { sourceId, nodeId: GROUP_PREFIX + base64UrlEncode(item.id) },
      kind: "folder",
      displayName: item.displayName,
      hasChildren: true,
      ...(item.parentLabel?.trim()
        ? { contextLabel: item.parentLabel.trim() }
        : {}),
      ...(item.referenceCount == null
        ? {}
        : { childCount: item.referenceCount }),
      ...(item.iconUrl ? { iconUrl: item.iconUrl } : {})
    };
  }
  const reference = item.reference;
  return {
    ref: { sourceId, nodeId: FILE_PREFIX + base64UrlEncode(reference.path) },
    kind: "file",
    displayName: reference.displayName?.trim() || basename(reference.path),
    ...(reference.parentLabel?.trim()
      ? { contextLabel: reference.parentLabel.trim() }
      : {}),
    ...(reference.createdTimeMs == null
      ? {}
      : { createdTimeMs: reference.createdTimeMs }),
    ...(reference.sizeBytes == null ? {} : { sizeBytes: reference.sizeBytes }),
    ...(reference.mtimeMs == null ? {} : { mtimeMs: reference.mtimeMs }),
    ...(reference.mimeType ? { mimeType: reference.mimeType } : {})
  };
}

function decodeSegment(prefix: string, nodeId: string): string {
  if (!nodeId.startsWith(prefix)) {
    throw new Error(
      `reference-list nodeId missing ${prefix} prefix: ${nodeId}`
    );
  }
  return base64UrlDecode(nodeId.slice(prefix.length));
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** UTF-8 安全的 base64url(浏览器/Node 通用)。 */
export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
