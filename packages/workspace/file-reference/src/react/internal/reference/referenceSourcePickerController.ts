import { proxy } from "valtio/vanilla";
import type {
  ReferenceNode,
  ReferenceScope,
  SelectedReference
} from "../../../contracts/referenceSource.ts";
import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";
import { SOURCE_ROOT_NODE_ID } from "../../../core/referenceSourceAggregator.ts";
import {
  appendReferencePage,
  nodeRefKey,
  sortReferenceNodes
} from "../../../core/referenceSourceUtils.ts";

/**
 * node-keyed 多源 picker 的逻辑层 controller(顶部分源 tab)。
 * 独立于现有 WorkspaceFileReferencePickerController —— issue-manager 不受影响。
 * 设计见 docs/architecture/agent-reference-source-services.md §2 / §3。
 *
 * 本层只管:tabs、per-source inline 展开树(node-keyed)、cursor 加载更多、
 * per-tab 搜索、跨 tab 选中集、confirm。预览/打开留待 UI 接入步骤。
 */

export type ReferenceSourcePickerMode = "browse" | "search";

export interface ReferenceSourceNodeChildrenState {
  /** 已累积的子节点(含多页 append)。 */
  entries: ReferenceNode[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: Error | null;
}

export interface ReferenceSourceTabState {
  sourceId: string;
  expandedKeys: Record<string, boolean>;
  /** key = nodeRefKey;源根用 ROOT_CHILDREN_KEY。 */
  childrenByKey: Record<string, ReferenceSourceNodeChildrenState>;
  mode: ReferenceSourcePickerMode;
  searchQuery: string;
  searchEntries: ReferenceNode[];
  searchNextCursor: string | null;
  isSearchLoading: boolean;
  searchError: Error | null;
}

export interface ReferenceSourcePickerSnapshot {
  isLoadingTabs: boolean;
  tabsError: Error | null;
  tabs: ReferenceSourceTab[];
  activeSourceId: string | null;
  bySource: Record<string, ReferenceSourceTabState>;
  /** 跨 tab 累积的选中文件节点,按选中顺序。 */
  selection: ReferenceNode[];
}

export interface ReferenceSourcePickerController {
  readonly store: ReferenceSourcePickerSnapshot;
  getSnapshot(): ReferenceSourcePickerSnapshot;
  open(): void;
  close(): void;
  reset(): void;
  setActiveSource(sourceId: string): void;
  /** 确保某节点(null=当前源根)的子节点已加载(抽屉式导航进入用,不切换展开态)。 */
  ensureChildren(node: ReferenceNode | null): void;
  /** 确保指定源的根层级已加载(左栏可同时展开多源时,为非 active 源预载分组)。 */
  ensureSourceRoot(sourceId: string): void;
  toggleNode(node: ReferenceNode): void;
  loadMore(node: ReferenceNode | null): void;
  setSearchQuery(query: string): void;
  toggleSelection(node: ReferenceNode): void;
  clearSelection(): void;
  /**
   * 选中归一。文件 → 单条;文件夹按所属源区分:
   *  - 本地(非 navigable)源:保持单条 folder 引用(filesystem 路径与目录一一对应);
   *  - app/issue(navigable)源:其文件夹下文件在 filesystem 里不一定落在该目录路径下,
   *    故递归 listChildren 枚举,展开成多条文件引用。
   * 含异步枚举,故返回 Promise;结果按 path 去重、保序。
   */
  confirm(): Promise<SelectedReference[]>;
}

export interface CreateReferenceSourcePickerControllerInput {
  aggregator: ReferenceSourceAggregator;
  scope: ReferenceScope;
  searchDebounceMs?: number;
}

/** 源根 children 的 key(node===null 时)。 */
export const ROOT_CHILDREN_KEY = nodeRefKey({
  sourceId: "",
  nodeId: SOURCE_ROOT_NODE_ID
});

const defaultSearchDebounceMs = 180;

function emptyTabState(sourceId: string): ReferenceSourceTabState {
  return {
    sourceId,
    expandedKeys: {},
    childrenByKey: {},
    mode: "browse",
    searchQuery: "",
    searchEntries: [],
    searchNextCursor: null,
    isSearchLoading: false,
    searchError: null
  };
}

function emptyChildrenState(): ReferenceSourceNodeChildrenState {
  return {
    entries: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    error: null
  };
}

export function createReferenceSourcePickerController(
  input: CreateReferenceSourcePickerControllerInput
): ReferenceSourcePickerController {
  const { aggregator, scope } = input;
  const searchDebounceMs = input.searchDebounceMs ?? defaultSearchDebounceMs;

  let retained = false;
  let tabsSequence = 0;
  let browseSequence = 0;
  let searchSequence = 0;
  let searchAbortController: AbortController | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  let snapshot: ReferenceSourcePickerSnapshot = {
    isLoadingTabs: false,
    tabsError: null,
    tabs: [],
    activeSourceId: null,
    bySource: {},
    selection: []
  };
  const store = proxy(snapshot);

  const setSnapshot = (
    update:
      | Partial<ReferenceSourcePickerSnapshot>
      | ((
          current: ReferenceSourcePickerSnapshot
        ) => ReferenceSourcePickerSnapshot)
  ) => {
    const next =
      typeof update === "function"
        ? update(snapshot)
        : { ...snapshot, ...update };
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    Object.assign(store, next);
  };

  /** 不可变地更新某 tab 的状态。 */
  const updateTab = (
    sourceId: string,
    updater: (tab: ReferenceSourceTabState) => ReferenceSourceTabState
  ) => {
    setSnapshot((current) => {
      const existing = current.bySource[sourceId] ?? emptyTabState(sourceId);
      const nextTab = updater(existing);
      if (nextTab === existing) {
        return current;
      }
      return {
        ...current,
        bySource: { ...current.bySource, [sourceId]: nextTab }
      };
    });
  };

  const childrenKeyForNode = (node: ReferenceNode | null): string =>
    node ? nodeRefKey(node.ref) : ROOT_CHILDREN_KEY;

  const setChildrenState = (
    sourceId: string,
    key: string,
    patch: Partial<ReferenceSourceNodeChildrenState>
  ) => {
    updateTab(sourceId, (tab) => {
      const current = tab.childrenByKey[key] ?? emptyChildrenState();
      return {
        ...tab,
        childrenByKey: {
          ...tab.childrenByKey,
          [key]: { ...current, ...patch }
        }
      };
    });
  };

  const loadChildren = async (
    sourceId: string,
    node: ReferenceNode | null,
    options: { append: boolean }
  ) => {
    if (!retained) {
      return;
    }
    const key = childrenKeyForNode(node);
    const tab = snapshot.bySource[sourceId];
    const existing = tab?.childrenByKey[key];
    const cursor = options.append ? (existing?.nextCursor ?? null) : null;
    if (existing?.loading) {
      return;
    }
    if (options.append && !cursor) {
      return;
    }

    const sequence = ++browseSequence;
    setChildrenState(sourceId, key, { loading: true, error: null });

    try {
      const result = await aggregator.listChildren(
        scope,
        node ? node.ref : { sourceId, nodeId: SOURCE_ROOT_NODE_ID },
        { cursor }
      );
      if (!retained || sequence !== browseSequence) {
        return;
      }
      // append 走 cursor 语义:保序 append + 去重,不重排已得项(不变式 #4)。
      // 首次加载则整体排序(folder 在前、按名)。
      const prior =
        snapshot.bySource[sourceId]?.childrenByKey[key]?.entries ?? [];
      // 源声明已排序(如「最近访问」按访问时间倒序)时保留其顺序,不再重排。
      const entries = options.append
        ? appendReferencePage(prior, result.entries)
        : result.ordered
          ? [...result.entries]
          : sortReferenceNodes(result.entries);
      setChildrenState(sourceId, key, {
        entries,
        nextCursor: result.nextCursor ?? null,
        loaded: true,
        loading: false,
        error: null
      });
    } catch (error) {
      if (!retained || sequence !== browseSequence) {
        return;
      }
      setChildrenState(sourceId, key, {
        loading: false,
        error: normalizeError(error, "load children failed")
      });
    }
  };

  const ensureRootLoaded = (sourceId: string) => {
    const root = snapshot.bySource[sourceId]?.childrenByKey[ROOT_CHILDREN_KEY];
    if (root?.loaded || root?.loading) {
      return;
    }
    void loadChildren(sourceId, null, { append: false });
  };

  const loadTabs = async () => {
    if (!retained) {
      return;
    }
    const sequence = ++tabsSequence;
    setSnapshot({ isLoadingTabs: true, tabsError: null });
    try {
      const tabs = await aggregator.listSources(scope);
      if (!retained || sequence !== tabsSequence) {
        return;
      }
      const activeSourceId =
        snapshot.activeSourceId &&
        tabs.some((tab) => tab.sourceId === snapshot.activeSourceId)
          ? snapshot.activeSourceId
          : (tabs[0]?.sourceId ?? null);
      setSnapshot((current) => ({
        ...current,
        isLoadingTabs: false,
        tabs,
        activeSourceId,
        bySource: Object.fromEntries(
          tabs.map((tab) => [
            tab.sourceId,
            current.bySource[tab.sourceId] ?? emptyTabState(tab.sourceId)
          ])
        )
      }));
      if (activeSourceId) {
        ensureRootLoaded(activeSourceId);
      }
    } catch (error) {
      if (!retained || sequence !== tabsSequence) {
        return;
      }
      setSnapshot({
        isLoadingTabs: false,
        tabsError: normalizeError(error, "load reference sources failed")
      });
    }
  };

  const clearSearchTimer = () => {
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  };

  const cancelSearch = () => {
    clearSearchTimer();
    searchSequence += 1;
    searchAbortController?.abort();
    searchAbortController = null;
  };

  const runSearch = async (sourceId: string, query: string) => {
    if (!retained) {
      return;
    }
    const sequence = ++searchSequence;
    searchAbortController?.abort();
    const abortController = new AbortController();
    searchAbortController = abortController;
    updateTab(sourceId, (tab) => ({
      ...tab,
      isSearchLoading: true,
      searchError: null
    }));
    try {
      const result = await aggregator.search(scope, sourceId, {
        query,
        signal: abortController.signal
      });
      if (!retained || sequence !== searchSequence) {
        return;
      }
      updateTab(sourceId, (tab) => ({
        ...tab,
        isSearchLoading: false,
        searchEntries: sortReferenceNodes(result.entries),
        searchNextCursor: result.nextCursor ?? null,
        searchError: null
      }));
    } catch (error) {
      if (isAbortError(error) || !retained || sequence !== searchSequence) {
        return;
      }
      updateTab(sourceId, (tab) => ({
        ...tab,
        isSearchLoading: false,
        searchEntries: [],
        searchError: normalizeError(error, "reference search failed")
      }));
    } finally {
      if (sequence === searchSequence) {
        searchAbortController = null;
      }
    }
  };

  /**
   * 递归枚举文件夹下的所有文件节点(app/issue 源专用:文件夹引用需展开成逐个文件)。
   * 走 listChildren + cursor 分页,深入子文件夹;按 nodeRefKey 去重兼防环。不设数量上限。
   */
  const collectFolderFiles = async (
    folder: ReferenceNode
  ): Promise<ReferenceNode[]> => {
    const files: ReferenceNode[] = [];
    const seen = new Set<string>();
    const walk = async (node: ReferenceNode): Promise<void> => {
      let cursor: string | null = null;
      do {
        const result = await aggregator.listChildren(scope, node.ref, {
          cursor
        });
        for (const entry of result.entries) {
          const key = nodeRefKey(entry.ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          if (entry.kind === "folder") {
            await walk(entry);
          } else {
            files.push(entry);
          }
        }
        cursor = result.nextCursor ?? null;
      } while (cursor);
    };
    await walk(folder);
    return files;
  };

  const scheduleSearch = (sourceId: string, query: string) => {
    clearSearchTimer();
    if (!retained || !query) {
      return;
    }
    if (searchDebounceMs <= 0) {
      void runSearch(sourceId, query);
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(sourceId, query);
    }, searchDebounceMs);
  };

  return {
    get store() {
      return store;
    },
    getSnapshot() {
      return snapshot;
    },
    open() {
      if (retained) {
        return;
      }
      retained = true;
      void loadTabs();
    },
    close() {
      retained = false;
      cancelSearch();
      browseSequence += 1;
      tabsSequence += 1;
    },
    reset() {
      cancelSearch();
      browseSequence += 1;
      tabsSequence += 1;
      setSnapshot({
        isLoadingTabs: false,
        tabsError: null,
        tabs: [],
        activeSourceId: null,
        bySource: {},
        selection: []
      });
    },
    setActiveSource(sourceId) {
      if (!snapshot.tabs.some((tab) => tab.sourceId === sourceId)) {
        return;
      }
      cancelSearch();
      setSnapshot({ activeSourceId: sourceId });
      const tab = snapshot.bySource[sourceId];
      if (tab?.mode === "search" && tab.searchQuery.trim()) {
        scheduleSearch(sourceId, tab.searchQuery.trim());
      } else {
        ensureRootLoaded(sourceId);
      }
    },
    ensureChildren(node) {
      const sourceId = node ? node.ref.sourceId : snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const key = childrenKeyForNode(node);
      const childState = snapshot.bySource[sourceId]?.childrenByKey[key];
      if (!childState?.loaded && !childState?.loading) {
        void loadChildren(sourceId, node, { append: false });
      }
    },
    ensureSourceRoot(sourceId) {
      if (
        !sourceId ||
        !snapshot.tabs.some((tab) => tab.sourceId === sourceId)
      ) {
        return;
      }
      ensureRootLoaded(sourceId);
    },
    toggleNode(node) {
      if (node.kind !== "folder") {
        return;
      }
      const sourceId = node.ref.sourceId;
      const key = nodeRefKey(node.ref);
      const wasExpanded =
        snapshot.bySource[sourceId]?.expandedKeys[key] ?? false;
      const nextExpanded = !wasExpanded;
      updateTab(sourceId, (tab) => ({
        ...tab,
        expandedKeys: { ...tab.expandedKeys, [key]: nextExpanded }
      }));
      const childState = snapshot.bySource[sourceId]?.childrenByKey[key];
      if (nextExpanded && !childState?.loaded && !childState?.loading) {
        void loadChildren(sourceId, node, { append: false });
      }
    },
    loadMore(node) {
      const sourceId = node ? node.ref.sourceId : snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      void loadChildren(sourceId, node, { append: true });
    },
    setSearchQuery(query) {
      const sourceId = snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const trimmed = query.trim();
      const nextMode: ReferenceSourcePickerMode = trimmed ? "search" : "browse";
      updateTab(sourceId, (tab) => ({
        ...tab,
        searchQuery: query,
        mode: nextMode,
        ...(nextMode === "browse"
          ? { isSearchLoading: false, searchEntries: [], searchError: null }
          : {})
      }));
      if (nextMode === "search") {
        scheduleSearch(sourceId, trimmed);
      } else {
        cancelSearch();
        ensureRootLoaded(sourceId);
      }
    },
    toggleSelection(node) {
      // 文件与文件夹都可作为引用选中(文件夹的展开在 confirm 时按源处理)。
      const key = nodeRefKey(node.ref);
      setSnapshot((current) => {
        const exists = current.selection.some(
          (item) => nodeRefKey(item.ref) === key
        );
        return {
          ...current,
          selection: exists
            ? current.selection.filter((item) => nodeRefKey(item.ref) !== key)
            : [...current.selection, node]
        };
      });
    },
    clearSelection() {
      setSnapshot({ selection: [] });
    },
    async confirm() {
      const resolved: SelectedReference[] = [];
      const seenPaths = new Set<string>();
      const push = (ref: SelectedReference) => {
        if (seenPaths.has(ref.path)) {
          return;
        }
        seenPaths.add(ref.path);
        resolved.push(ref);
      };
      for (const node of snapshot.selection) {
        if (node.kind !== "folder") {
          push(aggregator.resolveSelection(node));
          continue;
        }
        const navigable =
          aggregator.getLoadedSource(node.ref.sourceId)?.capabilities
            .navigable ?? false;
        if (!navigable) {
          // 本地源:文件夹保持单条引用(目录路径在 filesystem 里有效)。
          push(aggregator.resolveSelection(node));
          continue;
        }
        // app/issue 源:文件夹下文件不一定落在该目录路径,递归枚举展开成逐个文件引用。
        const files = await collectFolderFiles(node);
        for (const fileNode of files) {
          push(aggregator.resolveSelection(fileNode));
        }
      }
      return resolved;
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
