import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import type {
  ReferenceNode,
  ReferenceScope,
  SelectedReference,
  WorkspaceFileReference
} from "../../../contracts/index.ts";
import {
  WORKSPACE_ROOT_GROUP_NODE_ID,
  nodeRefKey,
  selectedReferenceToWorkspaceFileReference
} from "../../../core/index.ts";
import type { ReferenceSourceAggregator } from "../../../core/referenceSourceAggregator.ts";
import {
  sortWorkspaceFileEntriesForArrangeMode,
  type WorkspaceFileEntry,
  type WorkspaceFileManagerArrangeMode
} from "@tutti-os/workspace-file-manager/services";
import {
  ROOT_CHILDREN_KEY,
  createReferenceSourcePickerController
} from "./referenceSourcePickerController.ts";

export type { WorkspaceFileManagerArrangeMode };

export { WORKSPACE_ROOT_GROUP_NODE_ID } from "../../../core/index.ts";

/** 本地源「工作区根」二级节点展示名(仅源未自带分组时的回退用)。 */
const WORKSPACE_ROOT_GROUP_LABEL = "工作区";

export interface UseReferenceSourcePickerViewInput {
  aggregator: ReferenceSourceAggregator;
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
}

/**
 * 多源 picker 的视图 hook。
 * controller 负责数据/缓存/分页/选中;hook 负责 UI 导航态(当前面包屑、焦点节点)。
 */
export function useReferenceSourcePickerView({
  aggregator,
  workspaceId,
  open,
  onClose,
  onConfirm
}: UseReferenceSourcePickerViewInput) {
  const readSnapshot = useSnapshot as <T extends object>(store: T) => T;
  const scope = useMemo<ReferenceScope>(() => ({ workspaceId }), [workspaceId]);

  const controller = useMemo(
    () => createReferenceSourcePickerController({ aggregator, scope }),
    [aggregator, scope]
  );
  const snapshot = readSnapshot(controller.store);

  // UI 导航态:每个源各一条面包屑栈([] = 源根)。
  const [breadcrumbBySource, setBreadcrumbBySource] = useState<
    Record<string, ReferenceNode[]>
  >({});
  const [focusedNode, setFocusedNode] = useState<ReferenceNode | null>(null);
  const [arrangeMode, setArrangeMode] =
    useState<WorkspaceFileManagerArrangeMode>("none");
  // 左栏一级源的展开态(可多源同时展开)。缺省:仅首个 active 源展开(见 seed effect)。
  const [expandedSources, setExpandedSources] = useState<
    Record<string, boolean>
  >({});
  const expandSeededRef = useRef(false);

  // 复用 file-manager 的排序能力:把 ReferenceNode 映射成 WorkspaceFileEntry 排序后映射回。
  const sortNodes = useCallback(
    (nodes: readonly ReferenceNode[]): ReferenceNode[] => {
      if (arrangeMode === "none") {
        return [...nodes];
      }
      const byKey = new Map<string, ReferenceNode>();
      const fileEntries: WorkspaceFileEntry[] = nodes.map((node) => {
        const key = nodeRefKey(node.ref);
        byKey.set(key, node);
        return {
          hasChildren: node.kind === "folder",
          kind: node.kind === "folder" ? "directory" : "file",
          mtimeMs: node.mtimeMs ?? null,
          name: node.displayName,
          path: key,
          sizeBytes: node.sizeBytes ?? null
        };
      });
      return sortWorkspaceFileEntriesForArrangeMode(fileEntries, arrangeMode)
        .map((entry) => byKey.get(entry.path))
        .filter((node): node is ReferenceNode => node !== undefined);
    },
    [arrangeMode]
  );
  // 每次打开对话框内,已自动进入过首个分组的源(避免覆盖用户手动导航/回到根)。
  const autoEnteredSourcesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      return;
    }
    controller.reset();
    controller.open();
    setBreadcrumbBySource({});
    setFocusedNode(null);
    setExpandedSources({});
    expandSeededRef.current = false;
    autoEnteredSourcesRef.current = new Set();
    return () => {
      controller.close();
    };
  }, [controller, open]);

  const activeSourceId = snapshot.activeSourceId;
  const activeTab = useMemo(
    () => snapshot.tabs.find((tab) => tab.sourceId === activeSourceId) ?? null,
    [activeSourceId, snapshot.tabs]
  );
  const capabilities = activeTab?.capabilities ?? null;

  const breadcrumb = activeSourceId
    ? (breadcrumbBySource[activeSourceId] ?? [])
    : [];
  const currentNode = breadcrumb.at(-1) ?? null;
  const currentKey = currentNode
    ? nodeRefKey(currentNode.ref)
    : ROOT_CHILDREN_KEY;

  const activeTabState = activeSourceId
    ? snapshot.bySource[activeSourceId]
    : undefined;
  const isSearch =
    activeTabState?.mode === "search" &&
    activeTabState.searchQuery.trim() !== "";

  const currentChildren = activeTabState?.childrenByKey[currentKey];

  // 浏览态内容区:当前选中二级节点(currentNode,本地根时为 null → 源根)的子节点,
  // 递归就地展开成文件树。搜索态:扁平搜索结果。
  const currentEntries = useMemo(
    () => sortNodes(currentChildren?.entries ?? []),
    [currentChildren?.entries, sortNodes]
  );
  const searchResults = useMemo(
    () => sortNodes(activeTabState?.searchEntries ?? []),
    [activeTabState?.searchEntries, sortNodes]
  );

  // 每个源的左栏二级分组(左栏可多源同时展开,故按源全量计算):
  //  - 源自带分组(listSidebarGroups,如本地源的 最近访问/下载/文稿/桌面/个人)优先;
  //  - 否则取该源根下的 folder;非 navigable 源额外合成「工作区根」入口保住根级散文件可达。
  // 依赖 snapshot.tabs(getLoadedSource 在 tabs 加载后才有值)与 snapshot.bySource(根加载)。
  const sidebarGroupsBySource = useMemo<Record<string, ReferenceNode[]>>(() => {
    const result: Record<string, ReferenceNode[]> = {};
    for (const tab of snapshot.tabs) {
      const sourceId = tab.sourceId;
      const provided = aggregator
        .getLoadedSource(sourceId)
        ?.listSidebarGroups?.(scope);
      if (provided && provided.length > 0) {
        result[sourceId] = provided;
        continue;
      }
      const root =
        snapshot.bySource[sourceId]?.childrenByKey[ROOT_CHILDREN_KEY];
      const folders = (root?.entries ?? []).filter(
        (node) => node.kind === "folder"
      );
      if (tab.capabilities.navigable) {
        result[sourceId] = folders;
      } else {
        const workspaceRoot: ReferenceNode = {
          ref: { sourceId, nodeId: WORKSPACE_ROOT_GROUP_NODE_ID },
          kind: "folder",
          displayName: WORKSPACE_ROOT_GROUP_LABEL
        };
        result[sourceId] = [workspaceRoot, ...folders];
      }
    }
    return result;
  }, [snapshot.tabs, snapshot.bySource, aggregator, scope]);

  // active 源的二级分组(供自动进入首组、选中高亮等复用)。
  const sidebarGroups = activeSourceId
    ? (sidebarGroupsBySource[activeSourceId] ?? [])
    : [];

  // 当前选中的二级分组 key(本地根选中时 = 合成「工作区根」节点的 key)。
  const selectedGroupKey =
    currentNode != null
      ? nodeRefKey(currentNode.ref)
      : activeSourceId && !capabilities?.navigable
        ? nodeRefKey({
            sourceId: activeSourceId,
            nodeId: WORKSPACE_ROOT_GROUP_NODE_ID
          })
        : null;

  const setActiveSource = useCallback(
    (sourceId: string) => {
      controller.setActiveSource(sourceId);
      setFocusedNode(null);
    },
    [controller]
  );

  const enterFolder = useCallback(
    (node: ReferenceNode) => {
      const sourceId = node.ref.sourceId;
      if (
        node.kind !== "folder" ||
        !sourceId ||
        node.ref.nodeId === WORKSPACE_ROOT_GROUP_NODE_ID
      ) {
        return;
      }
      controller.ensureChildren(node);
      setBreadcrumbBySource((current) => {
        const stack = current[sourceId] ?? [];
        const index = stack.findIndex(
          (item) => nodeRefKey(item.ref) === nodeRefKey(node.ref)
        );
        const nextStack =
          index >= 0 ? stack.slice(0, index + 1) : [...stack, node];
        return { ...current, [sourceId]: nextStack };
      });
      setFocusedNode(null);
    },
    [controller]
  );

  // 切到可逐层进入的源(如「应用」)时,默认进入第一个分组(app),
  // 而非停在根列表。每个源每次打开只自动选一次,用户回到根/手动导航后不再覆盖。
  useEffect(() => {
    if (!open || !activeSourceId || !capabilities?.navigable) {
      return;
    }
    if (autoEnteredSourcesRef.current.has(activeSourceId)) {
      return;
    }
    const stack = breadcrumbBySource[activeSourceId] ?? [];
    if (stack.length > 0) {
      // 该源已有导航(例如此前已自动/手动进入过),视为已初始化。
      autoEnteredSourcesRef.current.add(activeSourceId);
      return;
    }
    const firstGroup = sidebarGroups[0];
    if (!firstGroup) {
      // 根分组尚未加载完,等加载后再触发。
      return;
    }
    autoEnteredSourcesRef.current.add(activeSourceId);
    enterFolder(firstGroup);
  }, [
    open,
    activeSourceId,
    capabilities?.navigable,
    sidebarGroups,
    breadcrumbBySource,
    enterFolder
  ]);

  // 首次有 active 源时,默认展开它(其余源保持收起,用户可再独立展开)。
  useEffect(() => {
    if (!open || expandSeededRef.current || !activeSourceId) {
      return;
    }
    expandSeededRef.current = true;
    setExpandedSources((current) =>
      current[activeSourceId] != null
        ? current
        : { ...current, [activeSourceId]: true }
    );
  }, [open, activeSourceId]);

  const navigateToBreadcrumb = useCallback(
    (index: number) => {
      if (!activeSourceId) {
        return;
      }
      setBreadcrumbBySource((current) => {
        const stack = current[activeSourceId] ?? [];
        return { ...current, [activeSourceId]: stack.slice(0, index + 1) };
      });
      const target = (breadcrumbBySource[activeSourceId] ?? [])[index] ?? null;
      controller.ensureChildren(target);
      setFocusedNode(null);
    },
    [activeSourceId, breadcrumbBySource, controller]
  );

  const navigateToRoot = useCallback(
    (sourceId?: string) => {
      const sid = sourceId ?? activeSourceId;
      if (!sid) {
        return;
      }
      setBreadcrumbBySource((current) => ({ ...current, [sid]: [] }));
      controller.ensureSourceRoot(sid);
      setFocusedNode(null);
    },
    [activeSourceId, controller]
  );

  // 选中左栏二级分组:先切到该分组所属源(右侧内容随之切换),
  // 再:合成「工作区根」→ 回源根;其余 → 进入该目录。
  const selectGroup = useCallback(
    (node: ReferenceNode) => {
      const sourceId = node.ref.sourceId;
      if (!sourceId) {
        return;
      }
      if (sourceId !== snapshot.activeSourceId) {
        controller.setActiveSource(sourceId);
      }
      if (node.ref.nodeId === WORKSPACE_ROOT_GROUP_NODE_ID) {
        navigateToRoot(sourceId);
        return;
      }
      enterFolder(node);
    },
    [controller, snapshot.activeSourceId, enterFolder, navigateToRoot]
  );

  // 一级源展开态:缺省仅 active 源展开(seed effect);其余可独立切换、同时展开。
  const isSourceExpanded = useCallback(
    (sourceId: string) => expandedSources[sourceId] ?? false,
    [expandedSources]
  );

  const toggleSourceExpanded = useCallback(
    (sourceId: string) => {
      const willExpand = !(expandedSources[sourceId] ?? false);
      setExpandedSources((current) => ({
        ...current,
        [sourceId]: !(current[sourceId] ?? false)
      }));
      // 展开非自带分组的源时预载其根,以便其二级分组就绪。
      if (
        willExpand &&
        !aggregator.getLoadedSource(sourceId)?.listSidebarGroups
      ) {
        controller.ensureSourceRoot(sourceId);
      }
    },
    [aggregator, controller, expandedSources]
  );

  const isSelected = useCallback(
    (node: ReferenceNode) =>
      snapshot.selection.some(
        (item) => nodeRefKey(item.ref) === nodeRefKey(node.ref)
      ),
    [snapshot.selection]
  );

  // app/issue 源的文件夹引用需异步递归枚举展开,故 confirm 异步;期间置 isConfirming 防重复提交。
  const [isConfirming, setIsConfirming] = useState(false);
  const confirm = useCallback(async () => {
    if (isConfirming) {
      return;
    }
    setIsConfirming(true);
    try {
      const selected: SelectedReference[] = await controller.confirm();
      onConfirm(selected.map(selectedReferenceToWorkspaceFileReference));
      onClose();
    } finally {
      setIsConfirming(false);
    }
  }, [controller, isConfirming, onClose, onConfirm]);

  return {
    tabs: snapshot.tabs,
    activeSourceId,
    activeTabLabel: activeTab?.label ?? "",
    capabilities,
    // 内容区递归就地树:当前选中二级节点的子条目(本地根时为源根子条目)。
    currentEntries,
    // 搜索态:扁平搜索结果。
    searchResults,
    expandedKeys: activeTabState?.expandedKeys ?? {},
    childrenByKey: activeTabState?.childrenByKey ?? {},
    toggleNode: (node: ReferenceNode) => controller.toggleNode(node),
    sortNodes,
    isLoadingTabs: snapshot.isLoadingTabs,
    breadcrumb,
    currentNode,
    sidebarGroups,
    sidebarGroupsBySource,
    isSourceExpanded,
    toggleSourceExpanded,
    selectedGroupKey,
    arrangeMode,
    setArrangeMode,
    isSearch,
    searchQuery: activeTabState?.searchQuery ?? "",
    isLoading: isSearch
      ? (activeTabState?.isSearchLoading ?? false)
      : (currentChildren?.loading ?? false),
    hasMore: !isSearch && Boolean(currentChildren?.nextCursor),
    focusedNode,
    selection: snapshot.selection,
    selectionCount: snapshot.selection.length,
    setActiveSource,
    enterFolder,
    selectGroup,
    navigateToBreadcrumb,
    navigateToRoot,
    setFocusedNode,
    setSearchQuery: (query: string) => controller.setSearchQuery(query),
    toggleSelection: (node: ReferenceNode) => controller.toggleSelection(node),
    loadMore: () => controller.loadMore(currentNode),
    isSelected,
    confirm,
    isConfirming
  };
}
