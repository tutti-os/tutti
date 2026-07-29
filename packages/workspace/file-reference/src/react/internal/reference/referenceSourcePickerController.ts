import { proxy } from "valtio/vanilla";
import type {
  NodeRef,
  ReferenceHandle,
  ReferenceLocateTarget,
  ReferenceNode,
  ReferenceScope,
  SelectedReference
} from "../../../contracts/referenceSource.ts";
import type { ReferenceProvenanceFilter } from "../../../contracts/referenceProvenance.ts";
import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";
import { SOURCE_ROOT_NODE_ID } from "../../../core/referenceSourceAggregator.ts";
import {
  appendReferencePage,
  dedupeReferenceNodes,
  nodeRefKey,
  sortReferenceNodes
} from "../../../core/referenceSourceUtils.ts";
import {
  referenceProvenanceFilterCacheKey,
  referenceProvenanceFilterIsActive
} from "../../../core/referenceProvenance.ts";

/**
 * node-keyed 多源 picker 的逻辑层 controller(顶部分源 tab)。
 * 独立于现有 WorkspaceFileReferencePickerController —— issue-manager 不受影响。
 * 设计见 docs/architecture/agent-reference-source-services.md §2 / §3。
 *
 * 本层只管:tabs、per-source inline 展开树(node-keyed)、cursor 加载更多、
 * per-tab 搜索、跨 tab 选中集、confirm。预览/打开留待 UI 接入步骤。
 */

export type ReferenceSourcePickerMode = "browse" | "search";
export type ReferencePickerSelectionMode = "multiple" | "single";

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
  /** 已选文件类型筛选分类 id(全局统一口径);与 searchQuery 一起构成「查询」。 */
  searchFilters: string[];
  /** 当前搜索限定的二级分组节点 nodeId(左栏选中分组);null = 跨整源搜索。 */
  searchScopeNodeId: string | null;
  searchEntries: ReferenceNode[];
  searchNextCursor: string | null;
  /**
   * 当前查询使用的结果上限(增长式分页:拉到底部时 +SEARCH_PAGE_SIZE 重查)。
   * 0 = 尚未发起查询;每次新查询(改关键词/筛选/分组/换源)重置为 SEARCH_PAGE_SIZE。
   */
  searchLimit: number;
  /** 是否可能还有更多结果(本页返回数 ≥ 请求上限,且未达全局上限)。 */
  searchHasMore: boolean;
  /** 正在加载下一页(增长 limit 重查在途);用于底部 spinner,不清空已有结果。 */
  isSearchLoadingMore: boolean;
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

/** confirmGrouped 的产物:一个 navigable 源文件夹 = 一个 bundle(保留分组)。 */
export interface ReferenceConfirmBundle {
  /** 被选中的文件夹节点(提供 displayName / iconUrl / ref 作为 bundle 身份)。 */
  root: ReferenceNode;
  /**
   * 该 bundle 归一成的可被 agent 解析的领域句柄(见 ReferenceHandle)。
   * 由所属源 describeReferenceHandle 解码;发给 agent 的 `mention://workspace-reference/...`
   * 由它构造,替代把文件路径全部展开。源不支持解码时为 null。
   */
  handle: ReferenceHandle | null;
}

export interface ReferenceConfirmGroupedResult {
  /** 单独选中的文件 + 非 navigable 源的文件夹(保持单条引用)。 */
  files: SelectedReference[];
  /** 每个 navigable 源文件夹一项,文件已折叠在内。 */
  bundles: ReferenceConfirmBundle[];
}

export interface ReferenceSourcePickerController {
  readonly store: ReferenceSourcePickerSnapshot;
  getSnapshot(): ReferenceSourcePickerSnapshot;
  open(): void;
  close(): void;
  reset(): void;
  setActiveSource(sourceId: string, scopeNodeId?: string | null): void;
  /**
   * 把「定位目标」解析为从源根到目标的真实 ReferenceNode 路径(root → leaf)。
   * 纯数据解析:逐层 listChildren 找到真实节点(带 displayName 等),不改动任何 UI/导航态。
   * 源不支持定位 / 未找到时返回部分路径(可能为空)。供「打开即定位」一次性应用。
   */
  locatePath(target: ReferenceLocateTarget): Promise<ReferenceNode[]>;
  /** 确保某节点(null=当前源根)的子节点已加载(抽屉式导航进入用,不切换展开态)。 */
  ensureChildren(node: ReferenceNode | null): void;
  /** 重新拉取某节点(null=当前源根)的子节点第一页,用于应用/议题等动态源刷新已加载分组。 */
  refreshChildren(node: ReferenceNode | null): void;
  /** 确保指定源的根层级已加载(左栏可同时展开多源时,为非 active 源预载分组)。 */
  ensureSourceRoot(sourceId: string): void;
  /** 幂等展开某 folder 并确保其子节点已加载(定位目标默认展开用)。 */
  expandNode(node: ReferenceNode): void;
  toggleNode(node: ReferenceNode): void;
  loadMore(node: ReferenceNode | null): void;
  /**
   * 拉取指定源根层级的下一页(左栏二级分组分页用)。
   * 与 loadMore(null) 的区别:后者只作用于 active 源;本方法显式指定源,
   * 使左栏任一源(无论是否 active)都能继续拉取其分组。
   */
  loadMoreSourceRoot(sourceId: string): void;
  /**
   * 设置搜索关键词。scopeNodeId 指定把搜索限定在 active 源内某个二级分组(左栏选中分组)
   * 的节点 nodeId;缺省/null = 跨整源搜索。只有关键词或 provenance 约束进入扁平查询态。
   */
  setSearchQuery(query: string, scopeNodeId?: string | null): void;
  /**
   * 设置已选文件类型筛选分类(全局统一口径)。无关键词时保持可导航的浏览树;
   * 有关键词时作为搜索参数下钻到 source。
   */
  setSearchFilters(filters: string[], scopeNodeId?: string | null): void;
  setProvenanceFilter(
    filter: ReferenceProvenanceFilter | null,
    scopeNodeId?: string | null
  ): void;
  /** 搜索进行中切换左栏分组时更新限定范围并以现有关键词/筛选重搜。 */
  setSearchScope(scopeNodeId: string | null): void;
  /**
   * 加载更多查询结果(增长式分页):以同一关键词/筛选、更大的 limit 立即重查,
   * 结果整体替换(保留旧结果直到新结果就绪)。无更多 / 在途 / 非查询态时 no-op。
   */
  loadMoreSearch(): void;
  createDirectory(
    parent: ReferenceNode | null,
    name: string
  ): Promise<ReferenceNode>;
  toggleSelection(node: ReferenceNode): void;
  toggleSingleSelectionAndExpand(node: ReferenceNode): void;
  clearSelection(): void;
  /**
   * 选中归一。文件 → 单条;文件夹按所属源区分:
   *  - 本地(非 navigable)源:保持单条 folder 引用(filesystem 路径与目录一一对应);
   *  - app/issue(navigable)源:其文件夹下文件在 filesystem 里不一定落在该目录路径下,
   *    故递归 listChildren 枚举,展开成多条文件引用。
   * 含异步枚举,故返回 Promise;结果按 path 去重、保序。
   */
  confirm(selection?: readonly ReferenceNode[]): Promise<SelectedReference[]>;
  /**
   * 与 confirm 同源,但保留分组:navigable 源的每个选中文件夹折叠成一个 bundle
   * (文件已递归展开在内),其余作为单条文件。供「文件夹 = 一个节点」的插入形态用。
   */
  confirmGrouped(
    selection?: readonly ReferenceNode[]
  ): Promise<ReferenceConfirmGroupedResult>;
}

export interface CreateReferenceSourcePickerControllerInput {
  aggregator: ReferenceSourceAggregator;
  scope: ReferenceScope;
  selectionMode?: ReferencePickerSelectionMode;
  /** 关键词搜索允许返回的节点类型。 */
  searchResultKind?: ReferenceNode["kind"];
  searchDebounceMs?: number;
}

/** 源根 children 的 key(node===null 时)。 */
export const ROOT_CHILDREN_KEY = nodeRefKey({
  sourceId: "",
  nodeId: SOURCE_ROOT_NODE_ID
});

const defaultSearchDebounceMs = 180;

/** 查询(搜索/筛选)结果的初始/每页步长。拉到底部 +一页 重查(增长式分页)。 */
export const SEARCH_PAGE_SIZE = 30;
/**
 * 查询结果的全局上限。增长式分页对每个源都用「同一关键词/筛选 + 更大 limit 重查」实现,
 * 由各源 daemon 自行夹取(本地 200、应用硬校验 ≤200、议题 ≤200),故统一封顶 200。
 */
export const SEARCH_MAX_LIMIT = 200;

function emptyTabState(sourceId: string): ReferenceSourceTabState {
  return {
    sourceId,
    expandedKeys: {},
    childrenByKey: {},
    mode: "browse",
    searchQuery: "",
    searchFilters: [],
    searchScopeNodeId: null,
    searchEntries: [],
    searchNextCursor: null,
    searchLimit: 0,
    searchHasMore: false,
    isSearchLoadingMore: false,
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
  let provenanceFilter: ReferenceProvenanceFilter | null = null;
  let provenanceFilterKey = "disabled";
  const { aggregator, scope } = input;
  const selectionMode = input.selectionMode ?? "multiple";
  const searchResultKind = input.searchResultKind;
  const searchDebounceMs = input.searchDebounceMs ?? defaultSearchDebounceMs;

  let retained = false;
  // tabs 加载完成的 promise(供 revealTarget 等到 setActiveSource 可生效)。
  let tabsReady: Promise<void> = Promise.resolve();
  let tabsSequence = 0;
  // 浏览取数的「按 key 隔离」失效计数:全局单调 ticket(nextBrowseSeq,永不回退/复用)
  // 派发,latestBrowseSeqByKey 记录每个 (source, children-key) 的最新 ticket。
  // 取数 resolve 时凭自身 ticket 是否仍为该 key 的最新值判定是否落库 —— 这样不同
  // key 的并发取数互不作废(否则全局单计数会让后发的取数把先发的另一 key 取数结果
  // 静默丢弃、令其 loading 永不清除)。close/reset 清空该表使全部在途取数失效。
  let nextBrowseSeq = 0;
  const latestBrowseSeqByKey = new Map<string, number>();
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

    // ROOT_CHILDREN_KEY 等常量 key 在各源间复用,故 ticket 表按 (source, key) 命名空间。
    const seqKey = `${sourceId} ${key}`;
    const sequence = ++nextBrowseSeq;
    latestBrowseSeqByKey.set(seqKey, sequence);
    setChildrenState(sourceId, key, { loading: true, error: null });

    try {
      const result = await aggregator.listChildren(
        scope,
        node ? node.ref : { sourceId, nodeId: SOURCE_ROOT_NODE_ID },
        { cursor }
      );
      if (!retained || latestBrowseSeqByKey.get(seqKey) !== sequence) {
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
      if (!retained || latestBrowseSeqByKey.get(seqKey) !== sequence) {
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

  const runSearch = async (
    sourceId: string,
    query: string,
    filters: string[],
    scopeNodeId: string | null,
    limit: number,
    loadingMore: boolean
  ) => {
    if (!retained) {
      return;
    }
    const sequence = ++searchSequence;
    searchAbortController?.abort();
    const abortController = new AbortController();
    searchAbortController = abortController;
    // 加载更多:只置底部 spinner、保留旧结果;新查询:置主 loading。
    updateTab(sourceId, (tab) => ({
      ...tab,
      ...(loadingMore
        ? { isSearchLoadingMore: true }
        : { isSearchLoading: true }),
      searchError: null
    }));
    try {
      const result = await aggregator.search(scope, sourceId, {
        query,
        limit,
        provenanceFilter,
        signal: abortController.signal,
        ...(searchResultKind ? { kinds: [searchResultKind] } : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(scopeNodeId == null ? {} : { withinNodeId: scopeNodeId })
      });
      if (!retained || sequence !== searchSequence) {
        return;
      }
      updateTab(sourceId, (tab) => ({
        ...tab,
        isSearchLoading: false,
        isSearchLoadingMore: false,
        // Search sources own relevance order. Browsing may group folders and
        // sort names, but search must only deduplicate the ranked response.
        searchEntries: dedupeReferenceNodes(result.entries),
        searchNextCursor: result.nextCursor ?? null,
        searchLimit: limit,
        // 本页返回数达到请求上限、且未触全局上限 → 认为可能还有更多(增长式分页启发式)。
        searchHasMore:
          result.entries.length >= limit && limit < SEARCH_MAX_LIMIT,
        searchError: null
      }));
    } catch (error) {
      if (isAbortError(error) || !retained || sequence !== searchSequence) {
        return;
      }
      updateTab(sourceId, (tab) => ({
        ...tab,
        isSearchLoading: false,
        isSearchLoadingMore: false,
        // 加载更多失败时保留已有结果,仅新查询失败才清空。
        ...(loadingMore ? {} : { searchEntries: [], searchHasMore: false }),
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

  const scheduleSearch = (
    sourceId: string,
    query: string,
    filters: string[],
    scopeNodeId: string | null
  ) => {
    clearSearchTimer();
    // 类型筛选自身属于浏览树投影,不触发递归搜索。
    if (
      !retained ||
      (!query && !referenceProvenanceFilterIsActive(provenanceFilter))
    ) {
      return;
    }
    // 新查询恒从首页(SEARCH_PAGE_SIZE)起。
    if (searchDebounceMs <= 0) {
      void runSearch(
        sourceId,
        query,
        filters,
        scopeNodeId,
        SEARCH_PAGE_SIZE,
        false
      );
      return;
    }
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(
        sourceId,
        query,
        filters,
        scopeNodeId,
        SEARCH_PAGE_SIZE,
        false
      );
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
      tabsReady = loadTabs();
    },
    close() {
      retained = false;
      cancelSearch();
      // 清空 ticket 表:在途取数 resolve 时其 key 已无最新 ticket(get→undefined),被丢弃。
      latestBrowseSeqByKey.clear();
      tabsSequence += 1;
    },
    reset() {
      cancelSearch();
      latestBrowseSeqByKey.clear();
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
    setActiveSource(sourceId, scopeNodeId) {
      if (!snapshot.tabs.some((tab) => tab.sourceId === sourceId)) {
        return;
      }
      // 跨源切换时把「当前查询」(切换前 active 源的关键词+筛选)带到目标源:
      // 有查询则在目标源已选分组范围内用同一查询重搜(切到对应 tab 即重搜),
      // 无查询则回浏览态加载源根。query 随 tab 走,搜索框/筛选在切源后仍可见。
      const prevTab = snapshot.activeSourceId
        ? snapshot.bySource[snapshot.activeSourceId]
        : undefined;
      const carriedQuery = prevTab?.searchQuery ?? "";
      const carriedFilters = prevTab?.searchFilters ?? [];
      const trimmed = carriedQuery.trim();
      const nextScopeNodeId =
        scopeNodeId !== undefined
          ? scopeNodeId
          : (snapshot.bySource[sourceId]?.searchScopeNodeId ?? null);
      cancelSearch();
      setSnapshot({ activeSourceId: sourceId });
      if (
        trimmed === "" &&
        !referenceProvenanceFilterIsActive(provenanceFilter)
      ) {
        // 没有关键词/来源查询时,目标源保持浏览态。文件类型筛选由视图层递归投影
        // 浏览树,不能把它误判为扁平搜索；切源/回源根时也必须继续保留。
        updateTab(sourceId, (tab) =>
          tab.mode === "browse" &&
          tab.searchQuery === "" &&
          tab.searchFilters === carriedFilters &&
          tab.searchScopeNodeId === nextScopeNodeId
            ? tab
            : {
                ...tab,
                mode: "browse",
                searchQuery: "",
                searchFilters: carriedFilters,
                searchScopeNodeId: nextScopeNodeId,
                searchEntries: [],
                searchHasMore: false,
                isSearchLoading: false,
                isSearchLoadingMore: false,
                searchError: null
              }
        );
        ensureRootLoaded(sourceId);
        return;
      }
      // 范围用目标源自身已选分组(尚未进过分组则 null=跨整源);随后左栏自动/手动
      // 进入分组会经 setSearchScope 再以新范围重搜(去抖窗口内合并,不重复请求)。
      updateTab(sourceId, (tab) => ({
        ...tab,
        searchQuery: carriedQuery,
        searchFilters: carriedFilters,
        searchScopeNodeId: nextScopeNodeId,
        mode: "search",
        // 沿用旧结果直到新结果就绪,避免切源瞬间闪空。
        isSearchLoading: true,
        searchError: null
      }));
      scheduleSearch(sourceId, trimmed, carriedFilters, nextScopeNodeId);
    },
    async locatePath(target) {
      // 等 tabs 就绪(view 在本 promise resolve 后再 setActiveSource,届时 tabs 已加载)。
      await tabsReady;
      if (!retained) {
        return [];
      }
      const refs = await aggregator.locateTarget(
        scope,
        target.sourceId,
        target.params
      );
      if (!refs || refs.length === 0) {
        return [];
      }
      // 逐层 listChildren,把不透明 NodeRef 解析成带 displayName 的真实节点。
      const path: ReferenceNode[] = [];
      let parent: NodeRef = {
        sourceId: target.sourceId,
        nodeId: SOURCE_ROOT_NODE_ID
      };
      for (const ref of refs) {
        const targetKey = nodeRefKey(ref);
        const parentKey =
          parent.nodeId === SOURCE_ROOT_NODE_ID
            ? ROOT_CHILDREN_KEY
            : nodeRefKey(parent);
        let locatedEntries: ReferenceNode[] = [];
        let cursor: string | null = null;
        let node: ReferenceNode | undefined;
        do {
          const { entries, nextCursor } = await aggregator.listChildren(
            scope,
            parent,
            { cursor }
          );
          locatedEntries = appendReferencePage(locatedEntries, entries);
          node = entries.find((entry) => nodeRefKey(entry.ref) === targetKey);
          cursor = nextCursor ?? null;
        } while (!node && cursor);
        if (locatedEntries.length > 0) {
          const current =
            snapshot.bySource[parent.sourceId]?.childrenByKey[parentKey]
              ?.entries ?? [];
          setChildrenState(parent.sourceId, parentKey, {
            entries: appendReferencePage(current, locatedEntries),
            nextCursor: cursor,
            loaded: true,
            loading: false,
            error: null
          });
        }
        if (!node) {
          break;
        }
        path.push(node);
        parent = ref;
      }
      return path;
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
    refreshChildren(node) {
      const sourceId = node ? node.ref.sourceId : snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      void loadChildren(sourceId, node, { append: false });
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
    expandNode(node) {
      if (node.kind !== "folder") {
        return;
      }
      const sourceId = node.ref.sourceId;
      const key = nodeRefKey(node.ref);
      updateTab(sourceId, (tab) =>
        tab.expandedKeys[key] === true
          ? tab
          : {
              ...tab,
              expandedKeys: { ...tab.expandedKeys, [key]: true }
            }
      );
      const childState = snapshot.bySource[sourceId]?.childrenByKey[key];
      if (!childState?.loaded && !childState?.loading) {
        void loadChildren(sourceId, node, { append: false });
      }
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
    loadMoreSourceRoot(sourceId) {
      if (!sourceId) {
        return;
      }
      void loadChildren(sourceId, null, { append: true });
    },
    setSearchQuery(query, scopeNodeId = null) {
      const sourceId = snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const filters = snapshot.bySource[sourceId]?.searchFilters ?? [];
      const trimmed = query.trim();
      // 类型筛选不改变浏览/查询模式;只在已有关键词时参与搜索。
      const nextMode: ReferenceSourcePickerMode =
        trimmed || referenceProvenanceFilterIsActive(provenanceFilter)
          ? "search"
          : "browse";
      updateTab(sourceId, (tab) => ({
        ...tab,
        searchQuery: query,
        searchScopeNodeId: scopeNodeId,
        mode: nextMode,
        // 进入搜索:立刻置 loading(搜索是 debounce 的,否则键入到取数之间会先渲染空态,
        // 造成「空态 → spinner → 结果」闪烁)。保留上次 searchEntries,细化关键词时沿用旧结果而非闪空。
        ...(nextMode === "browse"
          ? { isSearchLoading: false, searchEntries: [], searchError: null }
          : { isSearchLoading: true, searchError: null })
      }));
      if (nextMode === "search") {
        scheduleSearch(sourceId, trimmed, filters, scopeNodeId);
      } else {
        cancelSearch();
        ensureRootLoaded(sourceId);
      }
    },
    setSearchFilters(filters, scopeNodeId = null) {
      const sourceId = snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const tab = snapshot.bySource[sourceId];
      const trimmed = tab?.searchQuery.trim() ?? "";
      const scopeId = scopeNodeId ?? tab?.searchScopeNodeId ?? null;
      const nextMode: ReferenceSourcePickerMode =
        trimmed || referenceProvenanceFilterIsActive(provenanceFilter)
          ? "search"
          : "browse";
      updateTab(sourceId, (current) => ({
        ...current,
        searchFilters: filters,
        searchScopeNodeId: scopeId,
        mode: nextMode,
        ...(nextMode === "browse"
          ? { isSearchLoading: false, searchEntries: [], searchError: null }
          : { isSearchLoading: true, searchError: null })
      }));
      if (nextMode === "search") {
        scheduleSearch(sourceId, trimmed, filters, scopeId);
      } else {
        cancelSearch();
        ensureRootLoaded(sourceId);
      }
    },
    setProvenanceFilter(filter, scopeNodeId = null) {
      const nextFilterKey = filter
        ? referenceProvenanceFilterCacheKey(filter)
        : "disabled";
      const sourceId = snapshot.activeSourceId;
      const tab = sourceId ? snapshot.bySource[sourceId] : undefined;
      const scopeId = scopeNodeId ?? tab?.searchScopeNodeId ?? null;
      const nextFilterActive = referenceProvenanceFilterIsActive(filter);
      if (
        nextFilterKey === provenanceFilterKey &&
        scopeId === (tab?.searchScopeNodeId ?? null) &&
        (!nextFilterActive || tab?.mode === "search")
      ) {
        return;
      }
      cancelSearch();
      provenanceFilter = filter;
      provenanceFilterKey = nextFilterKey;
      if (!sourceId) return;
      const query = tab?.searchQuery.trim() ?? "";
      const filters = tab?.searchFilters ?? [];
      const active = referenceProvenanceFilterIsActive(provenanceFilter);
      updateTab(sourceId, (current) => ({
        ...current,
        searchScopeNodeId: scopeId,
        mode: query || active ? "search" : "browse",
        ...(query || active
          ? { isSearchLoading: true, searchError: null }
          : { isSearchLoading: false, searchEntries: [], searchError: null })
      }));
      if (query || active) {
        scheduleSearch(sourceId, query, filters, scopeId);
      } else {
        cancelSearch();
        ensureRootLoaded(sourceId);
      }
    },
    setSearchScope(scopeNodeId) {
      // 搜索中切换左栏分组(如从某 app 切到另一 app):更新限定范围并以现有关键词/筛选重搜。
      const sourceId = snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const tab = snapshot.bySource[sourceId];
      if (!tab || tab.searchScopeNodeId === scopeNodeId) {
        return;
      }
      updateTab(sourceId, (current) => ({
        ...current,
        searchScopeNodeId: scopeNodeId
      }));
      const trimmed = tab.searchQuery.trim();
      const filters = tab.searchFilters;
      if (
        tab.mode === "search" &&
        (trimmed || referenceProvenanceFilterIsActive(provenanceFilter))
      ) {
        scheduleSearch(sourceId, trimmed, filters, scopeNodeId);
      }
    },
    loadMoreSearch() {
      const sourceId = snapshot.activeSourceId;
      if (!sourceId) {
        return;
      }
      const tab = snapshot.bySource[sourceId];
      if (
        !tab ||
        tab.mode !== "search" ||
        !tab.searchHasMore ||
        tab.isSearchLoadingMore
      ) {
        return;
      }
      const trimmed = tab.searchQuery.trim();
      if (!trimmed && !referenceProvenanceFilterIsActive(provenanceFilter)) {
        return;
      }
      const nextLimit = Math.min(
        (tab.searchLimit || SEARCH_PAGE_SIZE) + SEARCH_PAGE_SIZE,
        SEARCH_MAX_LIMIT
      );
      if (nextLimit <= tab.searchLimit) {
        return;
      }
      // 加载更多立即触发(不去抖),清掉在途去抖的新查询定时器以免相互覆盖。
      clearSearchTimer();
      void runSearch(
        sourceId,
        trimmed,
        tab.searchFilters,
        tab.searchScopeNodeId,
        nextLimit,
        true
      );
    },
    async createDirectory(parent, name) {
      const sourceId = parent?.ref.sourceId ?? snapshot.activeSourceId;
      if (!sourceId) {
        throw new Error("reference directory source is not selected");
      }
      if (!aggregator.createDirectory) {
        throw new Error(
          "reference source aggregator cannot create directories"
        );
      }
      const created = await aggregator.createDirectory(scope, sourceId, {
        parent,
        name
      });
      const key = childrenKeyForNode(parent);
      const current = snapshot.bySource[sourceId]?.childrenByKey[key];
      if (current?.loaded) {
        setChildrenState(sourceId, key, {
          entries: sortReferenceNodes(
            dedupeReferenceNodes([...current.entries, created])
          )
        });
      } else {
        await loadChildren(sourceId, parent, { append: false });
      }
      if (parent) {
        const parentKey = nodeRefKey(parent.ref);
        updateTab(sourceId, (tab) => ({
          ...tab,
          expandedKeys: { ...tab.expandedKeys, [parentKey]: true }
        }));
      }
      setSnapshot({ selection: [created] });
      return created;
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
            : selectionMode === "single"
              ? [node]
              : [...current.selection, node]
        };
      });
    },
    toggleSingleSelectionAndExpand(node) {
      const key = nodeRefKey(node.ref);
      setSnapshot((current) => {
        if (current.selection.length > 1) {
          return current;
        }
        const exists = current.selection.some(
          (item) => nodeRefKey(item.ref) === key
        );
        return {
          ...current,
          selection: exists ? [] : [node]
        };
      });
      if (node.kind === "folder") {
        const sourceId = node.ref.sourceId;
        const childKey = nodeRefKey(node.ref);
        updateTab(sourceId, (tab) =>
          tab.expandedKeys[childKey] === true
            ? tab
            : {
                ...tab,
                expandedKeys: { ...tab.expandedKeys, [childKey]: true }
              }
        );
        const childState = snapshot.bySource[sourceId]?.childrenByKey[childKey];
        if (!childState?.loaded && !childState?.loading) {
          void loadChildren(sourceId, node, { append: false });
        }
      }
    },
    clearSelection() {
      setSnapshot({ selection: [] });
    },
    async confirm(selection = snapshot.selection) {
      const resolved: SelectedReference[] = [];
      const seenPaths = new Set<string>();
      const push = (ref: SelectedReference) => {
        if (seenPaths.has(ref.path)) {
          return;
        }
        seenPaths.add(ref.path);
        resolved.push(ref);
      };
      for (const node of selection) {
        if (node.kind !== "folder") {
          push(await aggregator.prepareSelection(scope, node));
          continue;
        }
        const navigable =
          aggregator.getLoadedSource(node.ref.sourceId)?.capabilities
            .navigable ?? false;
        if (!navigable) {
          // 本地源:文件夹保持单条引用(目录路径在 filesystem 里有效)。
          push(await aggregator.prepareSelection(scope, node));
          continue;
        }
        // app/issue 源:文件夹下文件不一定落在该目录路径,递归枚举展开成逐个文件引用。
        const files = await collectFolderFiles(node);
        for (const fileNode of files) {
          push(await aggregator.prepareSelection(scope, fileNode));
        }
      }
      return resolved;
    },
    async confirmGrouped(selection = snapshot.selection) {
      const files: SelectedReference[] = [];
      const bundles: ReferenceConfirmBundle[] = [];
      const seenPaths = new Set<string>();
      const pushFile = (ref: SelectedReference) => {
        if (seenPaths.has(ref.path)) {
          return;
        }
        seenPaths.add(ref.path);
        files.push(ref);
      };
      for (const node of selection) {
        const source = aggregator.getLoadedSource(node.ref.sourceId);
        const navigable =
          node.kind === "folder" && (source?.capabilities.navigable ?? false);
        if (!navigable) {
          // 文件、或非 navigable 源的文件夹:保持单条引用。
          pushFile(await aggregator.prepareSelection(scope, node));
          continue;
        }
        // navigable 源文件夹:折叠成一个 bundle。句柄由源解码,供 agent 经
        // `mention://workspace-reference/...` + CLI 按需解析。**不再递归展开文件**——
        // agent 序列化走句柄、chip 数量取 childCount,故确认即时(大产物不再卡顿)。
        const handle = source?.describeReferenceHandle?.(node) ?? null;
        bundles.push({ root: node, handle });
      }
      return { files, bundles };
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
