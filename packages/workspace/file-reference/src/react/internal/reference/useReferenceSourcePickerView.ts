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
import type { ReferenceProvenanceFilter } from "../../../contracts/referenceProvenance.ts";
import {
  REFERENCE_FILTER_CATEGORIES,
  WORKSPACE_ROOT_GROUP_NODE_ID,
  nodeRefKey,
  referenceProvenanceFilterIsActive,
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
  createWorkspaceFilePreviewLoadedState,
  type WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import {
  ROOT_CHILDREN_KEY,
  createReferenceSourcePickerController
} from "./referenceSourcePickerController.ts";

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
 * 焦点节点的预览态(node-keyed)。复用 file-manager / file-preview 的分类逻辑
 * (createWorkspaceFilePreviewLoadedState),但只携带状态、不含已本地化文案 ——
 * 文案由 UI 层(ReferenceSourcePicker)按 status/reason 映射,保持 hook 与 i18n 解耦。
 */
export type ReferenceNodePreviewState =
  | { status: "empty" }
  | { node: ReferenceNode; status: "directory" }
  | { node: ReferenceNode; status: "loading" }
  | {
      content: string;
      node: ReferenceNode;
      previewSizeBytes?: number;
      status: "text";
    }
  | {
      content: string;
      node: ReferenceNode;
      previewSizeBytes?: number;
      status: "html";
    }
  | {
      node: ReferenceNode;
      objectUrl: string;
      previewSizeBytes?: number;
      status: "image";
    }
  | {
      node: ReferenceNode;
      objectUrl: string;
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
  /**
   * 本地源「工作区根」二级节点展示名(仅源未自带分组时的回退用)。
   * 由 UI 层注入已本地化文案,保持 hook 与 i18n 解耦。
   */
  workspaceRootGroupLabel: string;
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
  provenanceFilter?: ReferenceProvenanceFilter | null;
}

/**
 * 多源 picker 的视图 hook。
 * controller 负责数据/缓存/分页/选中;hook 负责 UI 导航态(当前面包屑、焦点节点)。
 */
export function useReferenceSourcePickerView({
  aggregator,
  workspaceId,
  open,
  workspaceRootGroupLabel,
  initialTarget = null,
  onClose,
  onConfirm,
  isNodeSelectable,
  onConfirmBundles,
  provenanceFilter = null
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
  // 已选文件类型筛选分类(与 searchQuery 一起构成「查询」)。
  const activeFilters = activeTabState?.searchFilters ?? [];
  // 查询态 = 关键词或筛选任一非空(controller 已据此置 mode)。命中即平铺结果。
  const isQuery =
    activeTabState?.mode === "search" &&
    (activeTabState.searchQuery.trim() !== "" ||
      activeFilters.length > 0 ||
      referenceProvenanceFilterIsActive(provenanceFilter));

  const currentChildren = activeTabState?.childrenByKey[currentKey];
  const contentError = isQuery
    ? (activeTabState?.searchError ?? null)
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
          displayName: workspaceRootGroupLabel
        };
        result[sourceId] = [workspaceRoot, ...folders];
      }
    }
    return result;
  }, [
    snapshot.tabs,
    snapshot.bySource,
    aggregator,
    scope,
    workspaceRootGroupLabel
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
  // 本地根(无面包屑、非 navigable)回退到合成「工作区根」节点。
  const rootGroupNode = breadcrumb[0] ?? null;
  // 搜索限定范围 = 左栏选中的二级分组(面包屑根项)的源内 nodeId;无选中分组(本地根)→ null,
  // 退回跨整源搜索。供「只搜选中应用」而非所有应用。
  const searchScopeNodeId = rootGroupNode ? rootGroupNode.ref.nodeId : null;
  const selectedGroupKey = rootGroupNode
    ? nodeRefKey(rootGroupNode.ref)
    : activeSourceId && !capabilities?.navigable
      ? nodeRefKey({
          sourceId: activeSourceId,
          nodeId: WORKSPACE_ROOT_GROUP_NODE_ID
        })
      : null;

  // 搜索进行中切换左栏分组(选中应用变化)时,把搜索限定范围同步给 controller 并重搜。
  // controller 内部仅在范围实际变化且处于搜索态时才重搜,浏览态/范围未变为 no-op。
  useEffect(() => {
    if (!open) return;
    controller.setProvenanceFilter(provenanceFilter, searchScopeNodeId);
    controller.setSearchScope(searchScopeNodeId);
  }, [activeSourceId, controller, open, provenanceFilter, searchScopeNodeId]);

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
  //  - 本地等非 navigable 源:进入第一个固定「位置」分组(本地源即「最近访问」),
  //    使从 agent GUI「+」按钮打开时默认落在「本地 - 最近访问」。
  // 每个源每次打开只自动选一次,用户回到根/手动导航后不再覆盖。
  // 非 navigable 源若无自带分组,sidebarGroups[0] 为合成「工作区根」,
  // enterFolder 对其 no-op,仍停在源根 —— 与原行为一致,无回归。
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
    const firstGroup = sidebarGroups[0];
    if (!firstGroup) {
      // 根分组尚未加载完,等加载后再触发。
      return;
    }
    autoEnteredSourcesRef.current.add(activeSourceId);
    enterFolder(firstGroup);
  }, [open, activeSourceId, sidebarGroups, breadcrumbBySource, enterFolder]);

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

  // 选中左栏二级分组:先切到该分组所属源(右侧内容随之切换),
  // 再:合成「工作区根」→ 回源根;其余 → 把面包屑重置为该分组。
  // 二级分组之间是同级关系(并非彼此嵌套),因此选中一个新分组时必须把面包屑
  // 重置为 [node],而非走 enterFolder 的「下钻入栈」逻辑 —— 否则点击同级分组会被
  // 当作子节点追加成 [A, B],而高亮取 breadcrumb[0] 仍停在 A,导致新分组「选不中」。
  const selectGroup = useCallback(
    (node: ReferenceNode) => {
      const sourceId = node.ref.sourceId;
      if (!sourceId) {
        return;
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
    if (isConfirming) {
      return;
    }
    if (selectableSelection.length === 0) {
      controller.clearSelection();
      return;
    }
    setIsConfirming(true);
    try {
      if (onConfirmBundles) {
        const grouped = await controller.confirmGrouped(selectableSelection);
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
        onConfirm(selected.map(selectedReferenceToWorkspaceFileReference));
      }
      onClose();
    } finally {
      setIsConfirming(false);
    }
  }, [
    controller,
    isConfirming,
    onClose,
    onConfirm,
    onConfirmBundles,
    selectableSelection
  ]);

  // 焦点节点预览:文件夹→directory;文件→走源 readPreview,字节经 file-preview 分类
  // 成 image/text/readonly。image 用 object URL,切换/卸载时回收避免泄漏。
  const [previewState, setPreviewState] = useState<ReferenceNodePreviewState>({
    status: "empty"
  });
  const previewObjectUrlRef = useRef<string | null>(null);
  const revokePreviewObjectUrl = useCallback(() => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    const node = focusedNode;
    if (!node) {
      revokePreviewObjectUrl();
      setPreviewState({ status: "empty" });
      return;
    }
    if (node.kind === "folder") {
      revokePreviewObjectUrl();
      setPreviewState({ node, status: "directory" });
      return;
    }
    const previewable =
      aggregator.getLoadedSource(node.ref.sourceId)?.capabilities.previewable ??
      false;
    if (!previewable) {
      revokePreviewObjectUrl();
      setPreviewState({ node, status: "unsupported" });
      return;
    }

    let cancelled = false;
    revokePreviewObjectUrl();
    setPreviewState({ node, status: "loading" });
    void (async () => {
      try {
        const preview = await aggregator.readPreview(scope, node);
        if (cancelled) {
          return;
        }
        if (!preview) {
          setPreviewState({ node, status: "unsupported" });
          return;
        }
        const previewSizeBytes = preview.bytes.byteLength;
        const loadedSizeBytes =
          node.sizeBytes != null && node.sizeBytes > 0
            ? node.sizeBytes
            : previewSizeBytes;
        const loaded = createWorkspaceFilePreviewLoadedState({
          bytes: preview.bytes,
          contentType: preview.contentType,
          entry: {
            kind: node.kind,
            name: node.displayName,
            path: node.ref.nodeId,
            mtimeMs: node.mtimeMs ?? null,
            sizeBytes: loadedSizeBytes
          },
          target: {
            fileKind: preview.kind,
            name: node.displayName,
            path: node.ref.nodeId,
            mtimeMs: node.mtimeMs ?? null,
            sizeBytes: loadedSizeBytes
          }
        });
        if (cancelled) {
          return;
        }
        if (loaded.status === "image") {
          const objectUrl = URL.createObjectURL(
            new Blob([loaded.bytes], { type: loaded.contentType })
          );
          previewObjectUrlRef.current = objectUrl;
          setPreviewState({
            node,
            objectUrl,
            previewSizeBytes,
            status: "image"
          });
          return;
        }
        if (loaded.status === "video") {
          const objectUrl = URL.createObjectURL(
            new Blob([loaded.bytes], { type: loaded.contentType })
          );
          previewObjectUrlRef.current = objectUrl;
          setPreviewState({
            node,
            objectUrl,
            previewSizeBytes,
            status: "video"
          });
          return;
        }
        if (loaded.status === "text") {
          setPreviewState({
            content: loaded.content,
            node,
            previewSizeBytes,
            status: "text"
          });
          return;
        }
        if (loaded.status === "html") {
          setPreviewState({
            content: loaded.content,
            node,
            previewSizeBytes,
            status: "html"
          });
          return;
        }
        setPreviewState({
          node,
          previewSizeBytes,
          reason: loaded.reason,
          ...(loaded.maxSizeBytes == null
            ? {}
            : { maxSizeBytes: loaded.maxSizeBytes }),
          status: "readonly"
        });
      } catch {
        if (!cancelled) {
          setPreviewState({ node, status: "error" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [aggregator, focusedNode, revokePreviewObjectUrl, scope]);

  // 卸载时回收最后一个 image object URL。
  useEffect(() => revokePreviewObjectUrl, [revokePreviewObjectUrl]);

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
    childrenByKey: activeTabState?.childrenByKey ?? {},
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
    // 查询态(关键词或筛选任一非空)→ 平铺结果;否则浏览树。
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
      : (currentChildren?.loading ?? false),
    // 查询态:增长式分页是否还有更多;浏览态:cursor 是否有下一页。
    hasMore: isQuery
      ? (activeTabState?.searchHasMore ?? false)
      : Boolean(currentChildren?.nextCursor),
    // 底部「加载更多」在途(查询态 = 增长重查;浏览态 = cursor append)。
    isLoadingMore: isQuery
      ? (activeTabState?.isSearchLoadingMore ?? false)
      : (currentChildren?.loading ?? false),
    focusedNode,
    selection: selectableSelection,
    selectionCount: selectableSelection.length,
    setActiveSource,
    enterFolder,
    selectGroup,
    navigateToBreadcrumb,
    navigateToRoot,
    setFocusedNode,
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
    isConfirming
  };
}
