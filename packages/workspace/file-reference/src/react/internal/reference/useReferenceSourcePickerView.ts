import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import type {
  ReferenceHandle,
  ReferenceLocateTarget,
  ReferenceNode,
  ReferenceScope,
  SelectedReference,
  WorkspaceFileReference
} from "../../../contracts/index.ts";
import {
  REFERENCE_FILTER_CATEGORIES,
  WORKSPACE_ROOT_GROUP_NODE_ID,
  nodeRefKey,
  selectedReferenceToWorkspaceFileReference
} from "../../../core/index.ts";
import type { ReferenceSourceAggregator } from "../../../core/referenceSourceAggregator.ts";
import {
  resolveWorkspaceFileOpenWithCacheKey,
  sortWorkspaceFileEntriesForArrangeMode,
  WorkspaceFileOpenWithApplicationsCache,
  type WorkspaceFileEntry,
  type WorkspaceFileManagerArrangeMode
} from "@tutti-os/workspace-file-manager/services";
import {
  createWorkspaceFilePreviewController,
  type WorkspaceFilePreviewControllerState,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import {
  ROOT_CHILDREN_KEY,
  createReferenceSourcePickerController,
  type ReferencePickerSelectionMode,
  type ReferenceSourceNodeChildrenState
} from "./referenceSourcePickerController.ts";
import { buildReferenceSourcePickerFilteredTree } from "./referenceSourcePickerFilterTree.ts";

export type { WorkspaceFileManagerArrangeMode };

export { WORKSPACE_ROOT_GROUP_NODE_ID } from "../../../core/index.ts";

function referenceNodeToOpenWithCacheEntry(
  node: ReferenceNode
): Pick<WorkspaceFileEntry, "kind" | "name" | "path"> {
  return {
    kind: node.kind === "folder" ? "directory" : "file",
    name: node.displayName,
    path: node.displayName
  };
}

/**
 * 焦点节点的预览态(node-keyed)。共享 file-preview controller 负责读取生命周期和
 * 规范状态,这里仅保留 picker 所需的节点投影;文案由 UI 层按 status/reason 映射。
 */
export type ReferenceNodePreviewState =
  | { status: "empty" }
  | { node: ReferenceNode; status: "directory" }
  | {
      node: ReferenceNode;
      previewKind?: WorkspaceFilePreviewKind;
      status: "loading";
    }
  | {
      content: string;
      node: ReferenceNode;
      previewKind: WorkspaceFilePreviewKind;
      previewSizeBytes?: number;
      status: "text";
    }
  | {
      node: ReferenceNode;
      objectUrl: string;
      previewKind: "image";
      previewSizeBytes?: number;
      status: "image";
    }
  | {
      node: ReferenceNode;
      objectUrl: string;
      previewKind: "video";
      previewSizeBytes?: number;
      status: "video";
    }
  | {
      maxSizeBytes?: number;
      node: ReferenceNode;
      previewSizeBytes?: number;
      reason: WorkspaceFilePreviewReadonlyReason;
      status: "readonly";
    }
  | { node: ReferenceNode; status: "unsupported" }
  | { node: ReferenceNode; status: "error" };

/** 一个 navigable 源文件夹的折叠选区(文件已映射为 WorkspaceFileReference)。 */
export interface ReferenceBundleSelection {
  sourceId: string;
  nodeId: string;
  displayName: string;
  iconUrl?: string | null;
  /**
   * 可被 agent 解析的领域句柄(见 ReferenceHandle)。发给 agent 的
   * `mention://workspace-reference/...` 由它构造;源未解码出句柄时为 null。
   */
  handle: ReferenceHandle | null;
  /** 该 bundle 下文件数(展示用,取节点 childCount;不再展开文件)。 */
  fileCount: number;
}

export interface ReferenceGroupedSelection {
  files: WorkspaceFileReference[];
  bundles: ReferenceBundleSelection[];
}

export interface UseReferenceSourcePickerViewInput {
  aggregator: ReferenceSourceAggregator;
  workspaceId: string;
  open: boolean;
  /** 可选:打开时直达某事项/应用分组(展开并聚焦)。 */
  initialTarget?: ReferenceLocateTarget | null;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
  isNodeSelectable?: (node: ReferenceNode) => boolean;
  /**
   * 可选:启用「文件夹=一个 bundle」确认形态。提供时,confirm 改用 confirmGrouped,
   * navigable 源的选中文件夹折叠成一个 bundle,其余仍作为单条文件。
   */
  onConfirmBundles?: (result: ReferenceGroupedSelection) => void;
  searchResultKind?: ReferenceNode["kind"];
  selectionMode?: ReferencePickerSelectionMode;
}

interface FilteredTreeState {
  childrenByKey: Record<string, ReferenceSourceNodeChildrenState>;
  error: Error | null;
  key: string | null;
  loading: boolean;
}

/**
 * 多源 picker 的视图 hook。
 * controller 负责数据/缓存/分页/选中;hook 负责 UI 导航态(当前面包屑、焦点节点)。
 */
export function useReferenceSourcePickerView({
  aggregator,
  workspaceId,
  open,
  initialTarget = null,
  onClose,
  onConfirm,
  isNodeSelectable,
  onConfirmBundles,
  searchResultKind,
  selectionMode = "multiple"
}: UseReferenceSourcePickerViewInput) {
  const readSnapshot = useSnapshot as <T extends object>(store: T) => T;
  const scope = useMemo<ReferenceScope>(() => ({ workspaceId }), [workspaceId]);

  const controller = useMemo(
    () =>
      createReferenceSourcePickerController({
        aggregator,
        scope,
        selectionMode,
        searchResultKind
      }),
    [aggregator, scope, searchResultKind, selectionMode]
  );
  const snapshot = readSnapshot(controller.store);

  // UI 导航态:每个源各一条面包屑栈([] = 源根)。
  const [breadcrumbBySource, setBreadcrumbBySource] = useState<
    Record<string, ReferenceNode[]>
  >({});
  const [focusedNode, setFocusedNode] = useState<ReferenceNode | null>(null);
  const [arrangeMode, setArrangeMode] =
    useState<WorkspaceFileManagerArrangeMode>("none");
  const [filteredTreeState, setFilteredTreeState] = useState<FilteredTreeState>(
    {
      childrenByKey: {},
      error: null,
      key: null,
      loading: false
    }
  );
  const [filteredTreeRetrySequence, setFilteredTreeRetrySequence] = useState(0);
  const openWithApplicationsCache = useRef(
    new WorkspaceFileOpenWithApplicationsCache()
  );

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
  // 「打开即定位」一次性应用标记:每个 initialTarget 仅应用一次,应用后不再干预用户导航。
  const appliedInitialTargetRef = useRef<ReferenceLocateTarget | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    controller.reset();
    controller.open();
    setBreadcrumbBySource({});
    setFocusedNode(null);
    autoEnteredSourcesRef.current = new Set();
    appliedInitialTargetRef.current = null;
    return () => {
      controller.close();
    };
  }, [controller, open]);

  // 「打开即定位」:一次性把 initialTarget 解析为真实节点路径并应用导航,之后不再干预。
  //  - path[0] = 左栏二级分组(topic / app):作为面包屑根项进入 → 左栏选中 + 中间栏展示其内容;
  //  - path[last] 更深(如事项):在该分组内容里 setFocusedNode 高亮。
  // 解析(含等待 tabs 就绪、逐层取真实节点)全在 controller.locatePath 内完成;这里只应用结果一次。
  useEffect(() => {
    const target = initialTarget;
    if (!open || !target || appliedInitialTargetRef.current === target) {
      return;
    }
    appliedInitialTargetRef.current = target;
    // 让默认「自动进入首个分组」对该源让位,改由本次定位接管。
    autoEnteredSourcesRef.current.add(target.sourceId);
    let canceled = false;
    void controller
      .locatePath(target)
      .then((path) => {
        if (canceled) {
          return;
        }
        const group = path[0];
        if (!group) {
          // 未解析到分组:撤销让位,退回默认(进入首个分组)。
          autoEnteredSourcesRef.current.delete(target.sourceId);
          return;
        }
        controller.setActiveSource(target.sourceId);
        setBreadcrumbBySource((current) => ({
          ...current,
          [group.ref.sourceId]: [group]
        }));
        controller.ensureChildren(group);
        for (const node of path.slice(1)) {
          controller.expandNode(node);
        }
        const deepest = path[path.length - 1];
        setFocusedNode(path.length > 1 && deepest ? deepest : null);
      })
      .catch(() => {
        autoEnteredSourcesRef.current.delete(target.sourceId);
      });
    return () => {
      canceled = true;
    };
  }, [open, initialTarget, controller]);

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
  // 已选文件类型筛选分类。无关键词时它只投影当前浏览树,不切成扁平查询态。
  const activeFilters = activeTabState?.searchFilters ?? [];
  const activeFiltersSerialized = JSON.stringify(activeFilters);
  const recursiveFilters = useMemo(
    () => JSON.parse(activeFiltersSerialized) as string[],
    [activeFiltersSerialized]
  );
  const isQuery = activeTabState?.mode === "search";
  const recursiveFilterKey =
    activeSourceId && recursiveFilters.length > 0 && !isQuery
      ? JSON.stringify([activeSourceId, recursiveFilters])
      : null;
  const recursiveFilterActive = recursiveFilterKey !== null;
  const recursiveFilterRequestKey = recursiveFilterKey
    ? `${recursiveFilterKey}:${filteredTreeRetrySequence}`
    : null;

  useEffect(() => {
    if (
      !open ||
      !activeSourceId ||
      !recursiveFilterKey ||
      !recursiveFilterRequestKey
    ) {
      setFilteredTreeState({
        childrenByKey: {},
        error: null,
        key: null,
        loading: false
      });
      return;
    }

    const abortController = new AbortController();
    setFilteredTreeState({
      childrenByKey: {},
      error: null,
      key: recursiveFilterKey,
      loading: true
    });
    void buildReferenceSourcePickerFilteredTree({
      aggregator,
      filters: recursiveFilters,
      scope,
      signal: abortController.signal,
      sourceId: activeSourceId
    }).then(
      (tree) => {
        if (!abortController.signal.aborted) {
          setFilteredTreeState({
            childrenByKey: tree.childrenByKey,
            error: null,
            key: recursiveFilterKey,
            loading: false
          });
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setFilteredTreeState({
            childrenByKey: {},
            error: error instanceof Error ? error : new Error(String(error)),
            key: recursiveFilterKey,
            loading: false
          });
        }
      }
    );
    return () => abortController.abort();
  }, [
    activeSourceId,
    aggregator,
    open,
    recursiveFilterKey,
    recursiveFilterRequestKey,
    recursiveFilters,
    scope
  ]);

  const childrenByKey = useMemo(() => {
    const sourceChildren = activeTabState?.childrenByKey ?? {};
    if (!recursiveFilterActive) {
      return sourceChildren;
    }
    return filteredTreeState.key === recursiveFilterKey
      ? filteredTreeState.childrenByKey
      : {};
  }, [
    activeTabState?.childrenByKey,
    filteredTreeState.childrenByKey,
    filteredTreeState.key,
    recursiveFilterActive,
    recursiveFilterKey
  ]);

  const currentChildren = childrenByKey[currentKey];
  const contentError = isQuery
    ? (activeTabState?.searchError ?? null)
    : recursiveFilterActive && filteredTreeState.key === recursiveFilterKey
      ? filteredTreeState.error
      : (currentChildren?.error ?? null);

  // 浏览态内容区:当前选中二级节点(currentNode,本地根时为 null → 源根)的子节点,
  // 递归就地展开成文件树。搜索态:扁平搜索结果。
  const currentEntries = useMemo(
    () => sortNodes(currentChildren?.entries ?? []),
    [currentChildren?.entries, sortNodes]
  );
  const searchResults = useMemo(
    // Browse arrangement is a presentation preference. Search results keep the
    // source-owned relevance order regardless of that preference.
    () => [...(activeTabState?.searchEntries ?? [])] as ReferenceNode[],
    [activeTabState?.searchEntries]
  );

  // 每个源的左栏二级分组(左栏可多源同时展开,故按源全量计算):
  //  - 源自带分组(listSidebarGroups,如本地源的 最近访问/下载/文稿/桌面/个人)优先;
  //  - 否则取该源根下的 folder。源标题自身就是根入口,不再重复合成同名根目录。
  // 依赖 snapshot.tabs(getLoadedSource 在 tabs 加载后才有值)与 snapshot.bySource(根加载)。
  const sidebarGroupsBySource = useMemo<Record<string, ReferenceNode[]>>(() => {
    const result: Record<string, ReferenceNode[]> = {};
    for (const tab of snapshot.tabs) {
      const sourceId = tab.sourceId;
      if (sourceId === activeSourceId && recursiveFilterActive) {
        const root = childrenByKey[ROOT_CHILDREN_KEY];
        result[sourceId] = (root?.entries ?? []).filter(
          (node) => node.kind === "folder"
        );
        continue;
      }
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
      result[sourceId] = folders;
    }
    return result;
  }, [
    activeSourceId,
    aggregator,
    childrenByKey,
    recursiveFilterActive,
    scope,
    snapshot.bySource,
    snapshot.tabs
  ]);

  // 左栏二级分组「是否还能继续拉取」(分页用)。
  //  - 自带分组的源(本地源:最近访问/下载/… 固定「位置」)不分页,恒 false;
  //  - 其余 navigable 源分组取自源根 children,源根带 nextCursor 即可继续拉取。
  const sidebarHasMoreBySource = useMemo<Record<string, boolean>>(() => {
    const result: Record<string, boolean> = {};
    for (const tab of snapshot.tabs) {
      const sourceId = tab.sourceId;
      const provided = aggregator
        .getLoadedSource(sourceId)
        ?.listSidebarGroups?.(scope);
      if (provided && provided.length > 0) {
        result[sourceId] = false;
        continue;
      }
      const root =
        snapshot.bySource[sourceId]?.childrenByKey[ROOT_CHILDREN_KEY];
      result[sourceId] = Boolean(root?.nextCursor);
    }
    return result;
  }, [snapshot.tabs, snapshot.bySource, aggregator, scope]);

  // 左栏二级分组「正在拉取下一页」(源根已加载过且当前在 loading = append 在途)。
  const sidebarLoadingMoreBySource = useMemo<Record<string, boolean>>(() => {
    const result: Record<string, boolean> = {};
    for (const tab of snapshot.tabs) {
      const root =
        snapshot.bySource[tab.sourceId]?.childrenByKey[ROOT_CHILDREN_KEY];
      result[tab.sourceId] = Boolean(root?.loaded && root.loading);
    }
    return result;
  }, [snapshot.tabs, snapshot.bySource]);

  // active 源的二级分组(供自动进入首组、选中高亮等复用)。
  const sidebarGroups = activeSourceId
    ? (sidebarGroupsBySource[activeSourceId] ?? [])
    : [];

  // 左栏二级分组高亮 = 当前所在的「根 most 分组」(面包屑首项),而非最深叶子节点。
  // 这样下钻进事项(topic → 事项 → 产物)时,左栏仍高亮其所属 topic;进 app 子目录时仍高亮该 app。
  const rootGroupNode = breadcrumb[0] ?? null;
  // 搜索限定范围 = 左栏选中的二级分组(面包屑根项)的源内 nodeId;无选中分组(本地根)→ null,
  // 退回跨整源搜索。供「只搜选中应用」而非所有应用。
  const searchScopeNodeId = rootGroupNode ? rootGroupNode.ref.nodeId : null;
  const selectedGroupKey = rootGroupNode ? nodeRefKey(rootGroupNode.ref) : null;

  // 搜索进行中切换左栏分组(选中应用变化)时,把搜索限定范围同步给 controller 并重搜。
  // controller 内部仅在范围实际变化且处于搜索态时才重搜,浏览态/范围未变为 no-op。
  useEffect(() => {
    if (!open) return;
    controller.setSearchScope(searchScopeNodeId);
  }, [activeSourceId, controller, open, searchScopeNodeId]);

  const setActiveSource = useCallback(
    (sourceId: string) => {
      controller.setActiveSource(sourceId);
      setFocusedNode(null);
    },
    [controller]
  );

  const shouldRefreshChildrenOnEnter = useCallback(
    (sourceId: string) =>
      snapshot.tabs.find((tab) => tab.sourceId === sourceId)?.capabilities
        .navigable ?? false,
    [snapshot.tabs]
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
      if (shouldRefreshChildrenOnEnter(sourceId)) {
        controller.refreshChildren(node);
      } else {
        controller.ensureChildren(node);
      }
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
    [controller, shouldRefreshChildrenOnEnter]
  );

  // 进入某源时默认选中它的第一个二级分组,而非停在根列表:
  //  - 可逐层进入的源(如「应用」/「议题」):进入第一个分组(首个 app / topic);
  //  - 非 navigable 源仅在显式提供固定「位置」分组时进入首组(本地源即「最近访问」),
  //    使从 agent GUI「+」按钮打开时默认落在「本地 - 最近访问」。
  // 每个源每次打开只自动选一次,用户回到根/手动导航后不再覆盖。
  useEffect(() => {
    if (!open || !activeSourceId) {
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
    const hasProvidedSidebarGroups = Boolean(
      aggregator.getLoadedSource(activeSourceId)?.listSidebarGroups?.(scope)
        .length
    );
    if (!capabilities?.navigable && !hasProvidedSidebarGroups) {
      // 根目录派生出的 folder 只是快捷入口。默认停在源根,避免误入第一个目录。
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
    aggregator,
    breadcrumbBySource,
    capabilities?.navigable,
    enterFolder,
    scope,
    sidebarGroups
  ]);

  // 左栏一级源默认全部展开(Finder 风格,无折叠):tabs 就绪后预载每个源的根,
  // 使非自带分组的源(应用/任务,二级分组取根下 folder)其分组也立即就绪。
  useEffect(() => {
    if (!open) {
      return;
    }
    for (const tab of snapshot.tabs) {
      controller.ensureSourceRoot(tab.sourceId);
    }
  }, [open, snapshot.tabs, controller]);

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
      if (target && shouldRefreshChildrenOnEnter(target.ref.sourceId)) {
        controller.refreshChildren(target);
      } else {
        controller.ensureChildren(target);
      }
      setFocusedNode(null);
    },
    [
      activeSourceId,
      breadcrumbBySource,
      controller,
      shouldRefreshChildrenOnEnter
    ]
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

  const selectSourceRoot = useCallback(
    (sourceId: string) => {
      controller.setActiveSource(sourceId, null);
      controller.setSearchScope(null);
      setBreadcrumbBySource((current) => ({ ...current, [sourceId]: [] }));
      controller.ensureSourceRoot(sourceId);
      setFocusedNode(null);
    },
    [controller]
  );

  // 选中左栏二级分组:先切到该分组所属源(右侧内容随之切换),
  // 再:源显式提供的根哨兵 → 回源根;其余 → 把面包屑重置为该分组。
  // 二级分组之间是同级关系(并非彼此嵌套),因此选中一个新分组时必须把面包屑
  // 重置为 [node],而非走 enterFolder 的「下钻入栈」逻辑 —— 否则点击同级分组会被
  // 当作子节点追加成 [A, B],而高亮取 breadcrumb[0] 仍停在 A,导致新分组「选不中」。
  const selectGroup = useCallback(
    (node: ReferenceNode) => {
      const sourceId = node.ref.sourceId;
      if (!sourceId) {
        return;
      }
      if (
        selectionMode === "single" &&
        (isNodeSelectable?.(node) ?? true) &&
        !snapshot.selection.some(
          (selected) => nodeRefKey(selected.ref) === nodeRefKey(node.ref)
        )
      ) {
        controller.toggleSelection(node);
      }
      const nextScopeNodeId =
        node.ref.nodeId === WORKSPACE_ROOT_GROUP_NODE_ID
          ? null
          : node.ref.nodeId;
      if (sourceId !== snapshot.activeSourceId) {
        controller.setActiveSource(sourceId, nextScopeNodeId);
      }
      if (node.ref.nodeId === WORKSPACE_ROOT_GROUP_NODE_ID) {
        controller.setSearchScope(null);
        navigateToRoot(sourceId);
        return;
      }
      if (shouldRefreshChildrenOnEnter(sourceId)) {
        controller.refreshChildren(node);
      } else {
        controller.ensureChildren(node);
      }
      controller.setSearchScope(nextScopeNodeId);
      setBreadcrumbBySource((current) => ({ ...current, [sourceId]: [node] }));
      setFocusedNode(null);
    },
    [
      controller,
      isNodeSelectable,
      selectionMode,
      snapshot.selection,
      snapshot.activeSourceId,
      navigateToRoot,
      shouldRefreshChildrenOnEnter
    ]
  );

  const isSelected = useCallback(
    (node: ReferenceNode) =>
      (isNodeSelectable?.(node) ?? true) &&
      snapshot.selection.some(
        (item) => nodeRefKey(item.ref) === nodeRefKey(node.ref)
      ),
    [isNodeSelectable, snapshot.selection]
  );

  const isSelectable = useCallback(
    (node: ReferenceNode) => isNodeSelectable?.(node) ?? true,
    [isNodeSelectable]
  );
  const selectableSelection = useMemo(
    () => snapshot.selection.filter(isSelectable),
    [isSelectable, snapshot.selection]
  );

  // app/issue 源的文件夹引用需异步递归枚举展开,故 confirm 异步;期间置 isConfirming 防重复提交。
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<Error | null>(null);
  const confirmingRef = useRef(false);
  const confirmationGenerationRef = useRef(0);
  useEffect(() => {
    if (open) {
      return;
    }
    confirmationGenerationRef.current += 1;
    confirmingRef.current = false;
    setIsConfirming(false);
    setConfirmError(null);
  }, [open]);
  useEffect(
    () => () => {
      confirmationGenerationRef.current += 1;
      confirmingRef.current = false;
    },
    []
  );
  const [isOpeningReference, setIsOpeningReference] = useState(false);
  const runReferenceAction = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      if (isOpeningReference) {
        return;
      }
      setIsOpeningReference(true);
      try {
        await action();
      } finally {
        setIsOpeningReference(false);
      }
    },
    [isOpeningReference]
  );
  const confirm = useCallback(async () => {
    if (confirmingRef.current) {
      return;
    }
    if (selectableSelection.length === 0) {
      controller.clearSelection();
      return;
    }
    const confirmationGeneration = ++confirmationGenerationRef.current;
    confirmingRef.current = true;
    setIsConfirming(true);
    setConfirmError(null);
    try {
      if (onConfirmBundles) {
        const grouped = await controller.confirmGrouped(selectableSelection);
        if (confirmationGeneration !== confirmationGenerationRef.current) {
          return;
        }
        onConfirmBundles({
          files: grouped.files.map(selectedReferenceToWorkspaceFileReference),
          bundles: grouped.bundles.map((bundle) => ({
            sourceId: bundle.root.ref.sourceId,
            nodeId: bundle.root.ref.nodeId,
            displayName: bundle.root.displayName,
            iconUrl: bundle.root.iconUrl ?? null,
            handle: bundle.handle,
            // 展示用文件数:取节点 childCount(不再展开文件);缺省回退 0。
            fileCount: bundle.root.childCount ?? 0
          }))
        });
      } else {
        const selected: SelectedReference[] =
          await controller.confirm(selectableSelection);
        if (confirmationGeneration !== confirmationGenerationRef.current) {
          return;
        }
        onConfirm(selected.map(selectedReferenceToWorkspaceFileReference));
      }
      onClose();
    } catch (error) {
      if (confirmationGeneration !== confirmationGenerationRef.current) {
        return;
      }
      setConfirmError(
        error instanceof Error
          ? error
          : new Error("reference confirmation failed")
      );
    } finally {
      if (confirmationGeneration === confirmationGenerationRef.current) {
        confirmingRef.current = false;
        setIsConfirming(false);
      }
    }
  }, [controller, onClose, onConfirm, onConfirmBundles, selectableSelection]);

  const previewController = useMemo(
    () =>
      createWorkspaceFilePreviewController<ReferenceNode>({
        canReadEntry: (node) =>
          aggregator.getLoadedSource(node.ref.sourceId)?.capabilities
            .previewable === true,
        getEntryKey: (node) =>
          [
            nodeRefKey(node.ref),
            node.displayName,
            node.sizeBytes ?? "",
            node.mtimeMs ?? ""
          ].join("\0"),
        read: async ({ entry }) => {
          const preview = await aggregator.readPreview(scope, entry);
          return preview
            ? {
                bytes: preview.bytes,
                contentType: preview.contentType,
                kind: preview.kind
              }
            : null;
        },
        toPreviewEntry: (node) => ({
          kind: node.kind,
          mtimeMs: node.mtimeMs ?? null,
          name: node.displayName,
          path: node.ref.nodeId,
          sizeBytes: node.sizeBytes ?? null
        })
      }),
    [aggregator, scope]
  );
  const [previewControllerState, setPreviewControllerState] = useState(() =>
    previewController.getSnapshot()
  );

  useEffect(() => {
    const syncPreviewState = () => {
      setPreviewControllerState(previewController.getSnapshot());
    };
    const unsubscribe = previewController.subscribe(syncPreviewState);
    syncPreviewState();
    return () => {
      unsubscribe();
      void previewController.setEntry(null);
    };
  }, [previewController]);

  useEffect(() => {
    void previewController.setEntry(focusedNode);
  }, [focusedNode, previewController]);

  const previewState = projectReferenceNodePreviewState(previewControllerState);

  return {
    tabs: snapshot.tabs,
    activeSourceId,
    previewState,
    activeTabLabel: activeTab?.label ?? "",
    capabilities,
    // 内容区递归就地树:当前选中二级节点的子条目(本地根时为源根子条目)。
    currentEntries,
    // 搜索态:扁平搜索结果。
    searchResults,
    contentError,
    expandedKeys: activeTabState?.expandedKeys ?? {},
    childrenByKey,
    toggleNode: (node: ReferenceNode) => controller.toggleNode(node),
    sortNodes,
    isLoadingTabs: snapshot.isLoadingTabs,
    breadcrumb,
    currentNode,
    sidebarGroups,
    sidebarGroupsBySource,
    sidebarHasMoreBySource,
    sidebarLoadingMoreBySource,
    loadMoreSidebarGroups: (sourceId: string) =>
      controller.loadMoreSourceRoot(sourceId),
    selectedGroupKey,
    arrangeMode,
    setArrangeMode,
    // 关键词搜索态 → 平铺结果;类型筛选自身仍展示浏览树。
    isQuery,
    searchQuery: activeTabState?.searchQuery ?? "",
    // 当前源支持的文件类型筛选分类(不支持则空数组,picker 据此决定是否展示筛选下拉)。
    filterCategories: capabilities?.filterable
      ? REFERENCE_FILTER_CATEGORIES
      : [],
    activeFilters,
    // 搜索态:仅在「还没有任何结果」时显示 spinner;细化关键词(已有结果)时
    // 保留旧结果直到新结果就绪,避免内容区在 spinner/结果间反复切换造成闪烁。
    isLoading: isQuery
      ? (activeTabState?.isSearchLoading ?? false) &&
        (activeTabState?.searchEntries.length ?? 0) === 0
      : recursiveFilterActive
        ? filteredTreeState.key !== recursiveFilterKey ||
          filteredTreeState.loading
        : (currentChildren?.loading ?? false),
    // 查询态:增长式分页是否还有更多;浏览态:cursor 是否有下一页。
    hasMore: isQuery
      ? (activeTabState?.searchHasMore ?? false)
      : recursiveFilterActive
        ? false
        : Boolean(currentChildren?.nextCursor),
    // 底部「加载更多」在途(查询态 = 增长重查;浏览态 = cursor append)。
    isLoadingMore: isQuery
      ? (activeTabState?.isSearchLoadingMore ?? false)
      : recursiveFilterActive
        ? false
        : (currentChildren?.loading ?? false),
    focusedNode,
    selection: selectableSelection,
    selectionCount: selectableSelection.length,
    canCreateDirectory: capabilities?.directoryCreatable === true,
    setActiveSource,
    selectSourceRoot,
    enterFolder,
    selectGroup,
    navigateToBreadcrumb,
    navigateToRoot,
    setFocusedNode,
    createDirectory: async (parent: ReferenceNode | null, name: string) => {
      const created = await controller.createDirectory(parent, name);
      setFocusedNode(created);
      return created;
    },
    setSearchQuery: (query: string) =>
      controller.setSearchQuery(query, searchScopeNodeId),
    setFilters: (filters: string[]) =>
      controller.setSearchFilters(filters, searchScopeNodeId),
    toggleSelection: (node: ReferenceNode) => {
      if (isSelectable(node)) {
        controller.toggleSelection(node);
      }
    },
    toggleSingleSelectionAndExpand: (node: ReferenceNode) => {
      if (isSelectable(node)) {
        controller.toggleSingleSelectionAndExpand(node);
        return;
      }
      controller.clearSelection();
      if (node.kind === "folder") {
        controller.toggleNode(node);
      }
    },
    loadMore: () =>
      isQuery ? controller.loadMoreSearch() : controller.loadMore(currentNode),
    retryContent: () => {
      if (isQuery) {
        controller.setSearchQuery(
          activeTabState?.searchQuery ?? "",
          searchScopeNodeId
        );
        return;
      }
      if (recursiveFilterActive) {
        setFilteredTreeRetrySequence((current) => current + 1);
        return;
      }
      controller.refreshChildren(currentNode);
    },
    isSelectable,
    isSelected,
    isOpeningReference,
    getCachedOpenWithApplications: (node: ReferenceNode) =>
      openWithApplicationsCache.current.get(
        resolveWorkspaceFileOpenWithCacheKey(
          referenceNodeToOpenWithCacheEntry(node)
        )
      ),
    listOpenWithApplications: (node: ReferenceNode) =>
      openWithApplicationsCache.current.resolve(
        resolveWorkspaceFileOpenWithCacheKey(
          referenceNodeToOpenWithCacheEntry(node)
        ),
        () => aggregator.listOpenWithApplications(scope, node)
      ),
    openNode: (node: ReferenceNode) =>
      runReferenceAction(() => aggregator.open(scope, node)),
    openWithApplication: (node: ReferenceNode, applicationPath: string) =>
      runReferenceAction(() =>
        aggregator.openWithApplication(scope, node, applicationPath)
      ),
    openWithOtherApplication: (
      node: ReferenceNode,
      applicationPickerPrompt?: string
    ) =>
      runReferenceAction(() =>
        aggregator.openWithOtherApplication(
          scope,
          node,
          applicationPickerPrompt
        )
      ),
    revealNode: (node: ReferenceNode) =>
      runReferenceAction(() => aggregator.reveal(scope, node)),
    confirm,
    confirmError,
    isConfirming
  };
}

function projectReferenceNodePreviewState(
  state: WorkspaceFilePreviewControllerState<ReferenceNode>
): ReferenceNodePreviewState {
  switch (state.status) {
    case "empty":
      return state;
    case "directory":
      return { node: state.entry, status: "directory" };
    case "loading":
      return {
        node: state.entry,
        previewKind: state.previewKind,
        status: "loading"
      };
    case "text":
      return {
        content: state.content,
        node: state.entry,
        previewKind: state.previewKind,
        previewSizeBytes: state.previewSizeBytes,
        status: "text"
      };
    case "image":
      return {
        node: state.entry,
        objectUrl: state.objectUrl,
        previewKind: "image",
        previewSizeBytes: state.previewSizeBytes,
        status: "image"
      };
    case "video":
      return {
        node: state.entry,
        objectUrl: state.objectUrl,
        previewKind: "video",
        previewSizeBytes: state.previewSizeBytes,
        status: "video"
      };
    case "bytes":
      return { node: state.entry, status: "unsupported" };
    case "readonly":
      return {
        maxSizeBytes: state.maxSizeBytes,
        node: state.entry,
        previewSizeBytes: state.previewSizeBytes,
        reason: state.reason,
        status: "readonly"
      };
    case "unsupported":
      return { node: state.entry, status: "unsupported" };
    case "error":
      return { node: state.entry, status: "error" };
  }
}
