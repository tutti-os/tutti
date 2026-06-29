import type {
  ListChildrenInput,
  ListChildrenResult,
  ReferenceNode,
  ReferencePreview,
  ReferenceScope,
  ReferenceSourceService,
  SearchInput,
  SearchResult,
  SelectedReference,
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter
} from "@tutti-os/workspace-file-reference/contracts";
import {
  WORKSPACE_ROOT_GROUP_NODE_ID,
  matchesFilterCategories,
  normalizeReferenceNodeKind
} from "@tutti-os/workspace-file-reference/core";
import type { DesktopI18nKey } from "@shared/i18n";
import { translate } from "../../i18n/appRuntime.ts";

export const WORKSPACE_FILE_SOURCE_ID = "workspace-file";

/** 「最近访问」二级分组的 nodeId 哨兵。listChildren 据此走 recent 取数链路。 */
const RECENT_GROUP_NODE_ID = "__recent__";
const RECENT_REFERENCE_LIMIT = 100;

/**
 * 本地源左栏固定「位置」(顺序即展示顺序),复刻 macOS Finder 边栏收藏:
 * 最近访问 / 下载 / 文稿 / 桌面 / 个人(home 根)。
 * 下载、文稿、桌面为 home 下子目录,用「相对路径」(不带前导 /):
 * 本地源 logicalRoot == 用户 home 绝对路径,带前导 / 的 "/Downloads" 会被
 * NormalizeLogicalPathWithinRoot 判为越界(ErrPathEscapesRoot)导致列表为空;
 * 相对路径才会被 join 到 home 下。个人用源根哨兵;最近访问用 recent 哨兵。
 */
const LOCAL_SIDEBAR_GROUPS: ReadonlyArray<{
  nodeId: string;
  labelKey: DesktopI18nKey;
}> = [
  {
    nodeId: RECENT_GROUP_NODE_ID,
    labelKey: "workspace.referenceSources.sidebarRecent"
  },
  {
    nodeId: "Downloads",
    labelKey: "workspace.referenceSources.sidebarDownloads"
  },
  {
    nodeId: "Documents",
    labelKey: "workspace.referenceSources.sidebarDocuments"
  },
  { nodeId: "Desktop", labelKey: "workspace.referenceSources.sidebarDesktop" },
  {
    nodeId: WORKSPACE_ROOT_GROUP_NODE_ID,
    labelKey: "workspace.referenceSources.sidebarPersonal"
  }
];

/**
 * 本地文件源:1:1 包装现有 WorkspaceFileReferenceAdapter。
 * nodeId === path。回归防护:取数/打开/预览/插入产物与现状逐字段一致。
 * 设计见 docs/architecture/agent-reference-source-services.md §2.3 / §4。
 */
export function createWorkspaceFileReferenceSource(input: {
  adapter: WorkspaceFileReferenceAdapter;
  label: string;
  order?: number;
}): ReferenceSourceService {
  const { adapter, label } = input;

  function referenceToNode(ref: WorkspaceFileReference): ReferenceNode {
    const kind = normalizeReferenceNodeKind(ref.kind);
    return {
      ref: { sourceId: WORKSPACE_FILE_SOURCE_ID, nodeId: ref.path },
      kind,
      displayName: ref.displayName?.trim() || basename(ref.path),
      ...(kind === "folder" ? { hasChildren: true } : {}),
      ...(ref.createdTimeMs == null
        ? {}
        : { createdTimeMs: ref.createdTimeMs }),
      ...(ref.sizeBytes == null ? {} : { sizeBytes: ref.sizeBytes }),
      ...(ref.mtimeMs == null ? {} : { mtimeMs: ref.mtimeMs })
    };
  }

  function nodeToReference(node: ReferenceNode): WorkspaceFileReference {
    return { path: node.ref.nodeId, kind: node.kind };
  }

  return {
    metadata: { id: WORKSPACE_FILE_SOURCE_ID, label, order: input.order ?? 0 },
    // 本地文件:简版布局——无分组导航栏,但支持全局文件类型筛选。
    // filterable:已选分类作为 search() 的 filters 下钻到 daemon 的 /files/search 过滤。
    capabilities: {
      searchable: true,
      previewable: true,
      paginated: false,
      navigable: false,
      filterable: true
    },

    isAvailable: () => typeof adapter.listDirectory === "function",

    // 本地源自带固定「位置」二级分组,而非从源根目录推导。
    listSidebarGroups(): ReferenceNode[] {
      return LOCAL_SIDEBAR_GROUPS.map((group) => ({
        ref: { sourceId: WORKSPACE_FILE_SOURCE_ID, nodeId: group.nodeId },
        kind: "folder",
        displayName: translate(group.labelKey),
        hasChildren: true
      }));
    },

    async listChildren(
      scope: ReferenceScope,
      { node, signal }: ListChildrenInput
    ): Promise<ListChildrenResult> {
      // 「最近访问」:走 recent 取数链路,按访问时间倒序,声明 ordered 阻止重排。
      if (node?.nodeId === RECENT_GROUP_NODE_ID) {
        if (!adapter.listRecentReferences) {
          return { entries: [], nextCursor: null, ordered: true };
        }
        const refs = await adapter.listRecentReferences({
          workspaceId: scope.workspaceId,
          limit: RECENT_REFERENCE_LIMIT,
          ...(signal ? { signal } : {})
        });
        return {
          entries: refs.map(referenceToNode),
          nextCursor: null,
          ordered: true
        };
      }
      if (!adapter.listDirectory) {
        return { entries: [], nextCursor: null };
      }
      const listing = await adapter.listDirectory({
        workspaceId: scope.workspaceId,
        path: node ? node.nodeId : null
      });
      return {
        entries: listing.entries.map(referenceToNode),
        nextCursor: null
      };
    },

    async search(
      scope: ReferenceScope,
      { query, filters, limit, signal, withinNodeId }: SearchInput
    ): Promise<SearchResult> {
      if (withinNodeId === RECENT_GROUP_NODE_ID) {
        if (!adapter.listRecentReferences) {
          return { entries: [], nextCursor: null };
        }
        const normalizedQuery = query.trim().toLowerCase();
        const refs = await adapter.listRecentReferences({
          workspaceId: scope.workspaceId,
          limit: RECENT_REFERENCE_LIMIT,
          ...(signal ? { signal } : {})
        });
        const filteredRefs = refs.filter((ref) =>
          matchesRecentReferenceSearch(ref, normalizedQuery, filters ?? [])
        );
        return {
          entries:
            limit === undefined
              ? filteredRefs.map(referenceToNode)
              : filteredRefs.slice(0, limit).map(referenceToNode),
          nextCursor: null
        };
      }

      if (!adapter.searchReferences) {
        return { entries: [], nextCursor: null };
      }
      // 搜索范围 = 左栏选中的「位置」(withinNodeId,本地源 nodeId 即路径)。
      // 「最近访问」已在上方用 recent 列表本地过滤;「个人」是源根(home),
      // 无对应子目录 → 跨整根搜索;其余固定位置(下载/文稿/桌面,相对路径)
      // 下钻到 daemon 限定遍历起点。
      const within =
        withinNodeId &&
        withinNodeId !== RECENT_GROUP_NODE_ID &&
        withinNodeId !== WORKSPACE_ROOT_GROUP_NODE_ID
          ? withinNodeId
          : undefined;
      // query 与 filters 至少一项非空(controller 保证);仅选筛选(query 空)时
      // 由 daemon 按类型 list-all。filters 下钻到 /files/search 服务端过滤。
      const refs = await adapter.searchReferences({
        workspaceId: scope.workspaceId,
        query,
        ...(filters && filters.length > 0 ? { filters } : {}),
        ...(within ? { within } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(signal ? { signal } : {})
      });
      return { entries: refs.map(referenceToNode), nextCursor: null };
    },

    async open(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.openReference?.(nodeToReference(node));
    },

    async listOpenWithApplications(
      _scope: ReferenceScope,
      node: ReferenceNode
    ) {
      return (
        (await adapter.listOpenWithApplications?.(nodeToReference(node))) ?? []
      );
    },

    async openWithApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPath: string
    ): Promise<void> {
      await adapter.openReferenceWithApplication?.(
        nodeToReference(node),
        applicationPath
      );
    },

    async openWithOtherApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPickerPrompt?: string
    ): Promise<void> {
      await adapter.openReferenceWithOtherApplication?.(
        nodeToReference(node),
        applicationPickerPrompt
      );
    },

    async reveal(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.revealReference?.(nodeToReference(node));
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
        reference: nodeToReference(node)
      });
    },

    resolveSelection(node: ReferenceNode): SelectedReference {
      return {
        path: node.ref.nodeId,
        kind: node.kind,
        ...(node.displayName ? { displayName: node.displayName } : {})
      };
    }
  };
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function matchesRecentReferenceSearch(
  ref: WorkspaceFileReference,
  query: string,
  filters: readonly string[]
): boolean {
  const name = ref.displayName?.trim() || basename(ref.path);
  const isFolder = normalizeReferenceNodeKind(ref.kind) === "folder";
  if (!matchesFilterCategories(name, isFolder, filters)) {
    return false;
  }
  return query.length === 0 || name.toLowerCase().includes(query);
}
