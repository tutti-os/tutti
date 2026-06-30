import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import {
  ArrowRightIcon,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  FolderFilledIcon,
  Input,
  IssueIcon,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  SearchIcon,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from "@tutti-os/ui-system";
import { AddLinedIcon } from "@tutti-os/ui-system/icons";
import {
  WorkspaceFilePreviewSurface,
  type WorkspaceFilePreviewSurfaceState
} from "@tutti-os/workspace-file-preview/react";
import {
  WorkspaceFileManagerContextMenu,
  resolveRevealInFolderLabel,
  type WorkspaceFileEntry,
  type WorkspaceFileManagerI18nRuntime,
  type WorkspaceFileOpenWithApplication
} from "@tutti-os/workspace-file-manager";
import type {
  ReferenceLocateTarget,
  ReferenceNode
} from "../../../contracts/referenceSource.ts";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "../../../contracts/index.ts";
import type { ReferenceSourceAggregator } from "../../../core/referenceSourceAggregator.ts";
import {
  nodeRefKey,
  type ReferenceFilterCategory
} from "../../../core/index.ts";
import {
  useReferenceSourcePickerView,
  type ReferenceNodePreviewState,
  type ReferenceGroupedSelection
} from "../../../react/internal/reference/useReferenceSourcePickerView.ts";
import {
  formatReferenceNodePathText,
  formatReferencePreviewDateTime,
  resolveReferencePreviewTimestampMs,
  resolveReferencePreviewSizeBytes
} from "./referenceSourcePickerPresentation.ts";

export interface ReferenceSourcePickerProps {
  aggregator: ReferenceSourceAggregator;
  copy: WorkspaceFileReferenceCopy;
  /** 可选:打开时直达某事项/应用分组(展开并聚焦)。 */
  initialTarget?: ReferenceLocateTarget | null;
  isNodeSelectable?: (node: ReferenceNode) => boolean;
  fileManagerCopy?: WorkspaceFileManagerI18nRuntime;
  hostOs?: NodeJS.Platform;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => JSX.Element | null;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
  /**
   * 可选:启用「文件夹=一个 bundle 节点」确认形态。提供时确认走 confirmGrouped,
   * navigable 源的选中文件夹折叠成 bundle 回调,其余仍为单条文件。
   */
  onConfirmBundles?: (result: ReferenceGroupedSelection) => void;
  open: boolean;
  workspaceId: string;
}

/**
 * 左栏二级分组(应用/任务列表)默认最多展示的条目数;超出则折叠在「拉取更多」之后。
 * 点击「拉取更多」先展开已加载的隐藏分组;已加载分组全部可见后,若源端仍有续页(cursor),
 * 再复用同一入口拉取下一页。
 */
const SIDEBAR_GROUP_PAGE_SIZE = 5;

type PickerView = ReturnType<typeof useReferenceSourcePickerView>;
interface ReferenceSourceContextMenuState {
  node: ReferenceNode;
  x: number;
  y: number;
}

/** react-resizable-panels 命令式句柄(只用到 resize)。 */
type ResizablePanelHandle = { resize: (size: number) => void };

/**
 * 双击分割线:把 panel 自动适配到内容自然宽度。
 * 量 `[data-autofit-label]`(truncate 元素的 scrollWidth = 完整文本宽度)的最右边缘,
 * 加上尾部控件/内边距,折算成占整体宽度的百分比;resize 内部会按 minSize 再做夹取。
 */
function autoFitPanelWidth(
  groupEl: HTMLElement | null,
  contentEl: HTMLElement | null,
  panel: ResizablePanelHandle | null,
  trailingPx: number
): void {
  if (!groupEl || !contentEl || !panel) {
    return;
  }
  const groupWidth = groupEl.clientWidth;
  if (groupWidth <= 0) {
    return;
  }
  const contentLeft = contentEl.getBoundingClientRect().left;
  const labels = contentEl.querySelectorAll<HTMLElement>(
    "[data-autofit-label]"
  );
  let maxRight = 0;
  labels.forEach((label) => {
    const right =
      label.getBoundingClientRect().left - contentLeft + label.scrollWidth;
    if (right > maxRight) {
      maxRight = right;
    }
  });
  if (maxRight <= 0) {
    return;
  }
  const naturalWidth = maxRight + trailingPx;
  panel.resize(Math.min(80, (naturalWidth / groupWidth) * 100));
}

export function ReferenceSourcePicker({
  aggregator,
  copy,
  fileManagerCopy,
  hostOs = "darwin",
  initialTarget,
  isNodeSelectable,
  onClose,
  onConfirm,
  onConfirmBundles,
  open,
  resolveOpenWithApplicationIcon,
  workspaceId
}: ReferenceSourcePickerProps): JSX.Element | null {
  const titleId = useId();
  const view = useReferenceSourcePickerView({
    aggregator,
    workspaceId,
    open,
    workspaceRootGroupLabel: copy.t("referencePicker.workspaceRootGroup"),
    initialTarget,
    isNodeSelectable,
    onClose,
    onConfirm,
    onConfirmBundles
  });

  // 文件类型筛选已下沉为查询参数(view.activeFilters);此处只做切换/清空的转发。
  const activeFilterSet = new Set(view.activeFilters);
  const toggleFilter = (id: string) => {
    const next = new Set(activeFilterSet);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    view.setFilters([...next]);
  };
  const clearFilters = () => view.setFilters([]);
  const searchInput = useComposedInputValue({
    onCommit: view.setSearchQuery,
    value: view.searchQuery
  });

  // 三栏可拖拽 + 双击自动适配:layoutRef 量整体宽度,content/panel ref 用于双击适配。
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const menuBoundaryRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement | null>(null);
  const middleContentRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<ResizablePanelHandle | null>(null);
  const middlePanelRef = useRef<ResizablePanelHandle | null>(null);
  const [contextMenu, setContextMenu] =
    useState<ReferenceSourceContextMenuState | null>(null);
  const [openWithApplications, setOpenWithApplications] = useState<
    WorkspaceFileOpenWithApplication[]
  >([]);
  const [openWithLoading, setOpenWithLoading] = useState(false);

  useEffect(() => {
    if (!contextMenu || !fileManagerCopy) {
      setOpenWithApplications([]);
      setOpenWithLoading(false);
      return;
    }

    let cancelled = false;
    const cachedApplications = view.getCachedOpenWithApplications(
      contextMenu.node
    );
    if (cachedApplications) {
      setOpenWithApplications(cachedApplications);
      setOpenWithLoading(false);
      return;
    }

    setOpenWithApplications([]);
    setOpenWithLoading(true);
    void view
      .listOpenWithApplications(contextMenu.node)
      .then((applications) => {
        if (cancelled) {
          return;
        }
        setOpenWithApplications(applications);
        setOpenWithLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setOpenWithApplications([]);
        setOpenWithLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contextMenu?.node, fileManagerCopy]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function handlePointerDown(event: globalThis.PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && contextMenuRef.current?.contains(target)) {
        return;
      }
      if (
        target instanceof Element &&
        target.closest("[data-workspace-file-manager-submenu]")
      ) {
        return;
      }
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const openReferenceContextMenu = (
    event: MouseEvent<HTMLElement>,
    node: ReferenceNode
  ): void => {
    if (!fileManagerCopy || node.kind !== "file") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    view.setFocusedNode(node);
    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY
    });
  };

  if (!open) {
    return null;
  }

  const hasSelectedGroup = view.selectedGroupKey != null;
  const fitSidebar = () =>
    autoFitPanelWidth(
      layoutRef.current,
      sidebarContentRef.current,
      sidebarPanelRef.current,
      36
    );
  const fitMiddle = () =>
    autoFitPanelWidth(
      layoutRef.current,
      middleContentRef.current,
      middlePanelRef.current,
      56
    );

  const dialog = (
    <div
      className="nodrag fixed inset-0 grid place-items-center bg-[var(--backdrop)] px-3 py-4 backdrop-blur-md [-webkit-app-region:no-drag] sm:px-6 sm:py-8"
      style={{ zIndex: "var(--z-panel)" }}
      onClick={onClose}
    >
      <Card
        aria-labelledby={titleId}
        aria-modal="true"
        className="nodrag flex h-[min(88vh,46rem)] w-full max-w-5xl flex-col gap-0 overflow-hidden border-[var(--line-1)] bg-[var(--background-fronted)] py-0 text-[var(--text-primary)] shadow-panel [-webkit-app-region:no-drag]"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="gap-3 px-4 pt-4 pb-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <CardTitle id={titleId}>
              {copy.t("referencePicker.title")}
            </CardTitle>
            <Button
              aria-label={copy.t("actions.cancel")}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={onClose}
            >
              <CloseIcon size={16} />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 overflow-hidden border-t border-[var(--line-1)] p-0">
          <div ref={layoutRef} className="flex min-h-0 min-w-0 flex-1">
            <ResizablePanelGroup
              className="min-h-0 min-w-0 flex-1"
              orientation="horizontal"
              // 三栏初始占比(侧边栏更窄,类 Finder)。v4 在三面板下 `defaultSize` 初始布局会因注册时序被忽略而回退等分,
              // 这里用 `defaultLayout`(按 panel id 指定 flexGrow 权重)作为权威初始布局。
              defaultLayout={{ sidebar: 2.5, middle: 4.5, preview: 3 }}
            >
              <ResizablePanel
                id="sidebar"
                className="min-h-0 min-w-0"
                defaultSize={15}
                minSize="150px"
                panelRef={(handle) => {
                  sidebarPanelRef.current = handle;
                }}
              >
                <SourceSidebar
                  contentRef={sidebarContentRef}
                  copy={copy}
                  view={view}
                />
              </ResizablePanel>
              <ResizableHandle
                disableDoubleClick
                withHandle
                className="after:bg-[var(--line-1)]"
                onDoubleClick={fitSidebar}
              />
              <ResizablePanel
                id="middle"
                className="min-h-0 min-w-0"
                defaultSize={50}
                minSize="260px"
                panelRef={(handle) => {
                  middlePanelRef.current = handle;
                }}
              >
                <div
                  ref={menuBoundaryRef}
                  className="relative flex h-full min-h-0 flex-col"
                  data-slot="viewport-menu-boundary"
                  data-workspace-file-menu-boundary=""
                  style={
                    {
                      "--workspace-file-manager-dialog-overlay-z-index":
                        "100710"
                    } as CSSProperties
                  }
                >
                  <div className="flex items-center gap-2 border-b border-[var(--line-1)] p-3">
                    <div className="relative flex-1">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
                      <Input
                        className="pl-9"
                        placeholder={copy.t(
                          "referencePicker.searchPlaceholder"
                        )}
                        value={searchInput.value}
                        onBlur={searchInput.onBlur}
                        onChange={searchInput.onChange}
                        onCompositionEnd={searchInput.onCompositionEnd}
                        onCompositionStart={searchInput.onCompositionStart}
                      />
                    </div>
                    {view.capabilities?.filterable &&
                    view.filterCategories.length > 0 ? (
                      <FilterCategoryFilter
                        categories={view.filterCategories}
                        copy={copy}
                        selected={activeFilterSet}
                        onClear={clearFilters}
                        onToggle={toggleFilter}
                      />
                    ) : null}
                  </div>
                  <ScrollArea
                    className="min-h-0 flex-1"
                    viewportProps={{
                      // 拉到底部(距底 <120px)自动加载更多 —— 查询态走增长式分页,
                      // 浏览态走 cursor 续页。已在加载/无更多时由 loadMore 内部 no-op。
                      onScroll: (event) => {
                        const el = event.currentTarget;
                        if (
                          view.hasMore &&
                          !view.isLoading &&
                          !view.isLoadingMore &&
                          el.scrollHeight - el.scrollTop - el.clientHeight < 120
                        ) {
                          view.loadMore();
                        }
                      }
                    }}
                  >
                    <div
                      ref={middleContentRef}
                      className="flex flex-col gap-[2px] p-3"
                    >
                      {view.isLoading ? (
                        <Feedback>
                          <Spinner size={16} />
                        </Feedback>
                      ) : view.isQuery ? (
                        // 查询态(关键词或筛选):扁平结果
                        view.searchResults.length === 0 ? (
                          <Feedback>
                            {copy.t("referencePicker.emptySearch")}
                          </Feedback>
                        ) : (
                          view.searchResults.map((node) => (
                            <SearchResultRow
                              key={nodeRefKey(node.ref)}
                              focused={isFocused(view.focusedNode, node)}
                              node={node}
                              selected={view.isSelected(node)}
                              onFocus={view.setFocusedNode}
                              onContextMenu={openReferenceContextMenu}
                              onOpen={view.openNode}
                              selectable={view.isSelectable(node)}
                              onSingleSelect={
                                view.toggleSingleSelectionAndExpand
                              }
                              onToggle={view.toggleSelection}
                            />
                          ))
                        )
                      ) : view.currentEntries.length === 0 ? (
                        <Feedback>
                          {copy.t(
                            hasSelectedGroup
                              ? "referencePicker.emptyDirectory"
                              : "referencePicker.selectGroupHint"
                          )}
                        </Feedback>
                      ) : (
                        // 浏览:就地递归展开树(复刻 agent 引用面板文件树交互)
                        view.currentEntries.map((node) => (
                          <TreeNodeRow
                            key={nodeRefKey(node.ref)}
                            copy={copy}
                            depth={0}
                            node={node}
                            onContextMenu={openReferenceContextMenu}
                            view={view}
                          />
                        ))
                      )}
                      {view.hasMore && (view.isQuery || hasSelectedGroup) ? (
                        <Button
                          className="mt-1 w-full"
                          disabled={view.isLoadingMore}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={view.loadMore}
                        >
                          {view.isLoadingMore ? (
                            <Spinner className="text-current" size={14} />
                          ) : null}
                          {copy.t("referencePicker.loadMore")}
                        </Button>
                      ) : null}
                    </div>
                  </ScrollArea>
                  {fileManagerCopy ? (
                    <WorkspaceFileManagerContextMenu
                      busy={view.isOpeningReference}
                      contextMenu={
                        contextMenu
                          ? {
                              entry: referenceNodeToWorkspaceFileEntry(
                                contextMenu.node
                              ),
                              x: contextMenu.x,
                              y: contextMenu.y
                            }
                          : null
                      }
                      contextMenuRef={contextMenuRef}
                      copy={fileManagerCopy}
                      openWithApplications={openWithApplications}
                      openWithLoading={openWithLoading}
                      positionMode="viewport"
                      revealInFolderLabel={resolveRevealInFolderLabel(
                        fileManagerCopy,
                        hostOs
                      )}
                      resolveOpenWithApplicationIcon={
                        resolveOpenWithApplicationIcon
                      }
                      showCopyAction={false}
                      showCopyPathAction={false}
                      showCreateAction={false}
                      showDeleteAction={false}
                      showExportAction={false}
                      showImportAction={false}
                      showOpenInAppBrowserAction={false}
                      showOpenInDefaultBrowserAction={false}
                      showOpenInFileViewerAction={false}
                      showOpenWithAction={true}
                      showOpenWithOtherAction={true}
                      showRevealInFolderAction={true}
                      showRenameAction={false}
                      onClose={() => setContextMenu(null)}
                      onCopy={noopAsync}
                      onCopyPath={noopAsync}
                      onCreateDirectory={noopVoid}
                      onCreateFile={noopVoid}
                      onDelete={noopVoid}
                      onExport={noopAsync}
                      onImport={noopAsync}
                      onOpen={async () => {
                        if (contextMenu) {
                          await view.openNode(contextMenu.node);
                        }
                      }}
                      onOpenInAppBrowser={noopAsync}
                      onOpenInDefaultBrowser={noopAsync}
                      onOpenInFileViewer={noopAsync}
                      onOpenWithApplication={async (applicationPath) => {
                        if (contextMenu) {
                          await view.openWithApplication(
                            contextMenu.node,
                            applicationPath
                          );
                        }
                      }}
                      onOpenWithOtherApplication={async () => {
                        if (contextMenu) {
                          await view.openWithOtherApplication(
                            contextMenu.node,
                            fileManagerCopy.t("openWithOtherPickerPrompt")
                          );
                        }
                      }}
                      onRevealInFolder={async () => {
                        if (contextMenu) {
                          await view.revealNode(contextMenu.node);
                        }
                      }}
                      onRename={noopVoid}
                    />
                  ) : null}
                </div>
              </ResizablePanel>
              <ResizableHandle
                disableDoubleClick
                withHandle
                className="after:bg-[var(--line-1)]"
                onDoubleClick={fitMiddle}
              />
              <ResizablePanel
                id="preview"
                className="min-h-0 min-w-0"
                defaultSize={30}
                minSize="200px"
              >
                <PreviewInfoPane
                  copy={copy}
                  hierarchy={view.breadcrumb}
                  node={view.focusedNode}
                  previewState={view.previewState}
                  sourceLabel={view.activeTabLabel}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </CardContent>

        <Footer
          cancelLabel={copy.t("actions.cancel")}
          confirmLabel={copy.t("referencePicker.confirm")}
          countLabel={copy.t("referencePicker.selectedCount", {
            count: view.selectionCount
          })}
          disabled={view.selectionCount === 0}
          loading={view.isConfirming}
          selection={view.selection}
          onClose={onClose}
          onConfirm={() => void view.confirm()}
        />
      </Card>
    </div>
  );

  if (typeof document === "undefined") {
    return dialog;
  }
  return createPortal(dialog, document.body);
}

/**
 * 二级分组无自带 iconUrl 时的兜底图标:按源 metadata.icon 令牌选取。
 * 议题源(icon: "issue")用「事项」应用图标,其余回退到文件夹图标。
 */
function GroupFallbackIcon({
  icon,
  className
}: {
  icon?: string;
  className: string;
}): JSX.Element {
  if (icon === "issue") {
    return <IssueIcon className={className} />;
  }
  return <FolderFilledIcon className={className} />;
}

/**
 * 左侧边栏(类 macOS Finder 边栏):
 * 一级源(本地/应用/任务)作为常驻分组标题、默认全部展开、无折叠箭头;
 * 其下二级目录分组与标题左对齐(无额外缩进),靠图标区分层级。
 */
function SourceSidebar({
  copy,
  view,
  contentRef
}: {
  copy: WorkspaceFileReferenceCopy;
  view: PickerView;
  contentRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  // 选中分组(含 initialTarget 定位结果)变化时,把它滚入可视区。
  const selectedGroupRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedGroupRef.current?.scrollIntoView({ block: "nearest" });
  }, [view.selectedGroupKey]);
  // 每个源已展示的分组上限(默认一页);点「拉取更多」按页累加。源切换/重开会重置。
  const [shownBySource, setShownBySource] = useState<Record<string, number>>(
    {}
  );
  const loadMoreGroups = (sourceId: string) => {
    const groups = view.sidebarGroupsBySource[sourceId] ?? [];
    const limit = shownBySource[sourceId] ?? SIDEBAR_GROUP_PAGE_SIZE;
    // 点「查看更多」先展示全部已加载项;已全部可见时,同一入口再拉源端下一页。
    const visibleCount = Math.max(groups.length, limit);
    if (groups.length > limit) {
      setShownBySource((prev) => ({ ...prev, [sourceId]: visibleCount }));
      return;
    }
    if (view.sidebarHasMoreBySource[sourceId] ?? false) {
      view.loadMoreSidebarGroups(sourceId);
    }
  };
  return (
    <ScrollArea className="h-full min-h-0 w-full">
      <div ref={contentRef} className="flex flex-col gap-0.5 p-2">
        <p className="px-2 py-1 text-[11px] font-semibold text-[var(--text-tertiary)]">
          {copy.t("referencePicker.sourceColumn")}
        </p>
        {view.tabs.map((tab) => {
          const groups = view.sidebarGroupsBySource[tab.sourceId] ?? [];
          const limit = shownBySource[tab.sourceId] ?? SIDEBAR_GROUP_PAGE_SIZE;
          // 当前选中分组(如 initialTarget 定位到靠后的项)始终展示,避免「选中却被折叠」。
          const selectedIndex = groups.findIndex(
            (group) => nodeRefKey(group.ref) === view.selectedGroupKey
          );
          const effectiveLimit =
            selectedIndex >= limit ? selectedIndex + 1 : limit;
          const visibleGroups = groups.slice(0, effectiveLimit);
          const loadingMore =
            view.sidebarLoadingMoreBySource[tab.sourceId] ?? false;
          // 还能拉取更多 = 已加载分组超出当前展示上限,或源端仍有续页未取。
          const hasMore =
            groups.length > effectiveLimit ||
            (view.sidebarHasMoreBySource[tab.sourceId] ?? false);
          return (
            <div key={tab.sourceId} className="flex flex-col gap-0.5">
              {/* 一级源:Finder 风格分区标题,无箭头、不可折叠。 */}
              <p
                className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-[var(--text-tertiary)]"
                data-autofit-label
              >
                {tab.label}
              </p>
              {groups.length === 0 ? (
                view.isLoadingTabs ? (
                  <p className="px-2 py-1 text-[12px] text-[var(--text-tertiary)]">
                    …
                  </p>
                ) : null
              ) : (
                visibleGroups.map((group) => {
                  const key = nodeRefKey(group.ref);
                  const selected = key === view.selectedGroupKey;
                  return (
                    <button
                      key={key}
                      ref={selected ? selectedGroupRef : undefined}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] transition-colors",
                        selected
                          ? "bg-primary/10 font-medium text-[var(--text-primary)] hover:bg-primary/15"
                          : "text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
                      )}
                      type="button"
                      onClick={() => view.selectGroup(group)}
                    >
                      {group.iconUrl ? (
                        <img
                          alt=""
                          className="size-4 shrink-0 rounded-[3px] object-cover"
                          src={group.iconUrl}
                        />
                      ) : (
                        <GroupFallbackIcon
                          className="size-4 shrink-0 text-[var(--rich-text-folder)]"
                          icon={tab.icon}
                        />
                      )}
                      <FullTextTooltip content={group.displayName}>
                        <span
                          className="min-w-0 flex-1 truncate"
                          data-autofit-label
                        >
                          {group.displayName}
                        </span>
                      </FullTextTooltip>
                      {group.childCount != null ? (
                        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                          {group.childCount}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
              {hasMore ? (
                <button
                  className="flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
                  disabled={loadingMore}
                  type="button"
                  onClick={() => loadMoreGroups(tab.sourceId)}
                >
                  {loadingMore ? (
                    <Spinner
                      className="text-[var(--text-secondary)]"
                      size={12}
                    />
                  ) : (
                    <ChevronDownIcon
                      className="shrink-0 text-[var(--text-secondary)]"
                      size={12}
                    />
                  )}
                  <span>{copy.t("referencePicker.loadMoreGroups")}</span>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function SearchResultRow({
  node,
  focused,
  selected,
  selectable,
  onFocus,
  onContextMenu,
  onSingleSelect,
  onOpen,
  onToggle
}: {
  node: ReferenceNode;
  focused: boolean;
  selected: boolean;
  selectable: boolean;
  onFocus: (node: ReferenceNode) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, node: ReferenceNode) => void;
  onOpen: (node: ReferenceNode) => Promise<void>;
  onSingleSelect: (node: ReferenceNode) => void;
  onToggle: (node: ReferenceNode) => void;
}): JSX.Element {
  const isFolder = node.kind === "folder";
  const contextLabel = node.contextLabel ?? node.ref.nodeId;
  const active = selected || (focused && selectable);
  return (
    <div
      className={cn(
        "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[6px] border py-2.5 pr-1 pl-3 transition-colors",
        active
          ? "border-border bg-transparency-block"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-transparency-block"
      )}
      onClick={() => {
        onFocus(node);
        onSingleSelect(node);
      }}
      onContextMenu={(event) => onContextMenu(event, node)}
      onDoubleClick={(event) => {
        if (node.kind !== "file") {
          return;
        }
        event.stopPropagation();
        onFocus(node);
        void onOpen(node);
      }}
    >
      <div className="flex min-w-0 items-center gap-3 text-left">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--transparency-block)] text-[var(--text-tertiary)]">
          {isFolder ? (
            <FolderFilledIcon className="size-4 text-[var(--rich-text-folder)]" />
          ) : (
            <FileIcon className="size-4 text-[var(--text-tertiary)]" />
          )}
        </span>
        <span className="min-w-0">
          <FullTextTooltip content={node.displayName}>
            <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
              {node.displayName}
            </span>
          </FullTextTooltip>
          <FullTextTooltip content={contextLabel}>
            <span className="block truncate text-[11px] text-[var(--text-secondary)]">
              {contextLabel}
            </span>
          </FullTextTooltip>
        </span>
      </div>
      {selectable ? (
        <Button
          aria-label={node.displayName}
          aria-pressed={selected}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onFocus(node);
            onToggle(node);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {selected ? (
            <CheckIcon size={14} />
          ) : (
            <AddLinedIcon className="text-[var(--text-secondary)]" size={16} />
          )}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 把 hook 的 node-keyed 预览态映射成共享预览组件的 surface state,补上本地化文案。
 * previewState 可能短暂滞后于 node(异步加载间隙),不匹配时回退到 loading/directory。
 */
function toPreviewSurfaceState(
  node: ReferenceNode,
  previewState: ReferenceNodePreviewState,
  copy: WorkspaceFileReferenceCopy
): WorkspaceFilePreviewSurfaceState<ReferenceNode> {
  if (
    !("node" in previewState) ||
    nodeRefKey(previewState.node.ref) !== nodeRefKey(node.ref)
  ) {
    return node.kind === "folder"
      ? { entry: node, status: "directory" }
      : { entry: node, status: "loading" };
  }
  switch (previewState.status) {
    case "directory":
      return { entry: node, status: "directory" };
    case "loading":
      return { entry: node, status: "loading" };
    case "image":
      return {
        entry: node,
        objectUrl: previewState.objectUrl,
        status: "image"
      };
    case "video":
      return {
        entry: node,
        objectUrl: previewState.objectUrl,
        status: "video"
      };
    case "text":
      return { content: previewState.content, entry: node, status: "text" };
    case "html":
      return { content: previewState.content, entry: node, status: "html" };
    case "readonly":
      return {
        entry: node,
        message:
          previewState.reason === "binary"
            ? copy.t("referencePicker.previewBinary")
            : previewState.reason === "file_too_large" ||
                previewState.reason === "text_too_large"
              ? copy.t("referencePicker.previewTooLarge")
              : copy.t("referencePicker.previewUnsupported"),
        status: "readonly"
      };
    case "error":
      return {
        entry: node,
        message: copy.t("referencePicker.previewError"),
        status: "error"
      };
    case "unsupported":
      return {
        entry: node,
        message: copy.t("referencePicker.previewUnsupported"),
        status: "unsupported"
      };
  }
}

/**
 * 产出来源徽标配色:按一级源给「产出来源」徽标着色,复用 rich-text mention
 * 的语义 token(本地文件 / 应用产物 / 事项产物各自的 @mention 同色),保持
 * 全局一致。未知源回退到默认 secondary 徽标(返回 undefined)。
 * sourceId 取值见 contracts/referenceSource.ts 的枚举说明。
 * 注意:class 必须写成完整字面量,Tailwind JIT 不扫描拼接出来的类名。
 */
function sourceBadgeClassName(sourceId: string): string | undefined {
  return SOURCE_BADGE_CLASSES[sourceId];
}

const SOURCE_BADGE_CLASSES: Record<string, string> = {
  "workspace-file":
    "bg-[color-mix(in_srgb,var(--rich-text-mention-file)_12%,transparent)] text-[var(--rich-text-mention-file)]",
  "app-artifact":
    "bg-[color-mix(in_srgb,var(--rich-text-mention-app)_12%,transparent)] text-[var(--rich-text-mention-app)]",
  "issue-file":
    "bg-[color-mix(in_srgb,var(--rich-text-mention-issue)_12%,transparent)] text-[var(--rich-text-mention-issue)]"
};

function FullTextTooltip({
  children,
  content
}: {
  children: ReactNode;
  content: string;
}): JSX.Element {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        className="max-w-[min(520px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
        side="top"
        style={{
          maxWidth: "min(520px, calc(100vw - 32px))",
          overflowWrap: "anywhere",
          whiteSpace: "normal",
          backgroundColor: "var(--background-fronted)",
          border: "1px solid var(--border-1)",
          borderRadius: 6,
          boxShadow: "var(--shadow-soft)",
          color: "var(--text-primary)",
          padding: "4px 8px"
        }}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function PreviewInfoPane({
  copy,
  hierarchy,
  node,
  previewState,
  sourceLabel
}: {
  copy: WorkspaceFileReferenceCopy;
  hierarchy: readonly ReferenceNode[];
  node: ReferenceNode | null;
  previewState: ReferenceNodePreviewState;
  sourceLabel: string;
}): JSX.Element {
  const sizeBytes = node
    ? resolveReferencePreviewSizeBytes(node, previewState)
    : null;
  const timestampMs = node ? resolveReferencePreviewTimestampMs(node) : null;
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-[var(--background-fronted)]">
      {node ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          {/* 文件查看面板:复用 file-manager 的共享预览组件,真实渲染图片/文本内容。 */}
          <WorkspaceFilePreviewSurface<ReferenceNode>
            directoryMessage={copy.t("referencePicker.previewFolder")}
            emptyMessage={copy.t("referencePicker.emptyPreview")}
            frameClassName="flex aspect-[3/2] w-full flex-col items-center justify-center overflow-hidden rounded-[8px] border border-[var(--line-2,var(--border-2))] bg-[var(--transparency-block)] p-0 text-center"
            imageAlt={(entry) => entry.displayName}
            htmlFrameClassName="items-stretch justify-stretch bg-white"
            htmlTitle={(entry) => entry.displayName}
            imageFrameClassName="p-3"
            loadingIndicator={<Spinner size={16} />}
            loadingMessage={copy.t("referencePicker.previewLoading")}
            messageClassName="mx-auto max-w-[24ch] text-[13px] leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]"
            renderIcon={(entry) =>
              entry.kind === "folder" ? (
                <FolderFilledIcon className="size-9 text-[var(--rich-text-folder)]" />
              ) : (
                <FileIcon className="size-9 text-[var(--text-tertiary)]" />
              )
            }
            state={toPreviewSurfaceState(node, previewState, copy)}
            textClassName="h-full w-full overflow-auto p-3 text-left text-[11px] leading-5 whitespace-pre-wrap break-words text-[var(--text-primary)]"
            textFrameClassName="items-stretch justify-stretch"
          />
          <div className="space-y-1">
            <p className="truncate text-[15px] font-semibold">
              {node.displayName}
            </p>
            <ReferencePathText hierarchy={hierarchy} node={node} />
          </div>
          <dl className="space-y-2 text-[13px]">
            <InfoRow label={copy.t("referencePicker.previewSource")}>
              <Badge
                variant="secondary"
                className={sourceBadgeClassName(node.ref.sourceId)}
              >
                {sourceLabel}
              </Badge>
            </InfoRow>
            {timestampMs != null ? (
              <InfoRow label={copy.t("referencePicker.previewModified")}>
                {formatReferencePreviewDateTime(timestampMs)}
              </InfoRow>
            ) : null}
            {sizeBytes != null ? (
              <InfoRow label={copy.t("referencePicker.previewSize")}>
                {formatBytes(sizeBytes)}
              </InfoRow>
            ) : null}
          </dl>
        </div>
      ) : (
        <Feedback>{copy.t("referencePicker.emptyPreview")}</Feedback>
      )}
    </aside>
  );
}

function ReferencePathText({
  hierarchy,
  node
}: {
  hierarchy: readonly ReferenceNode[];
  node: ReferenceNode;
}): JSX.Element {
  const pathText = getReferenceNodePathText(node, hierarchy);
  const lastSlashIndex = pathText.lastIndexOf("/");
  if (lastSlashIndex <= 0 || lastSlashIndex === pathText.length - 1) {
    return (
      <p
        className="truncate text-[12px] leading-5 text-[var(--text-tertiary)]"
        title={pathText}
      >
        {pathText}
      </p>
    );
  }

  return (
    <p
      className="flex min-w-0 items-center text-[12px] leading-5 text-[var(--text-tertiary)]"
      title={pathText}
    >
      <span className="min-w-0 truncate">
        {pathText.slice(0, lastSlashIndex + 1)}
      </span>
      <span className="max-w-[65%] shrink-0 truncate">
        {pathText.slice(lastSlashIndex + 1)}
      </span>
    </p>
  );
}

function getReferenceNodePathText(
  node: ReferenceNode,
  hierarchy: readonly ReferenceNode[]
): string {
  return formatReferenceNodePathText(node, hierarchy);
}

function InfoRow({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[var(--text-primary)]">
        {children}
      </dd>
    </div>
  );
}

function Footer({
  cancelLabel,
  confirmLabel,
  countLabel,
  disabled,
  loading = false,
  selection,
  onClose,
  onConfirm
}: {
  cancelLabel: string;
  confirmLabel: string;
  countLabel: string;
  disabled: boolean;
  loading?: boolean;
  selection: readonly ReferenceNode[];
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const selectionTooltipId = useId();
  const [selectionTooltipOpen, setSelectionTooltipOpen] = useState(false);
  const selectionTooltipLabel = selection
    .map((node) => node.displayName)
    .join("\n");

  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--line-1)] px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[13px] text-[var(--text-secondary)]">
          {countLabel}
        </span>
        {selection.slice(0, 2).map((node) => (
          <Badge
            key={nodeRefKey(node.ref)}
            className="min-w-0 max-w-[12rem]"
            variant="secondary"
          >
            <FullTextTooltip content={node.displayName}>
              <span className="truncate">{node.displayName}</span>
            </FullTextTooltip>
          </Badge>
        ))}
        {selection.length > 2 ? (
          <span
            className="relative inline-flex shrink-0"
            onBlur={() => setSelectionTooltipOpen(false)}
            onFocus={() => setSelectionTooltipOpen(true)}
            onMouseEnter={() => setSelectionTooltipOpen(true)}
            onMouseLeave={() => setSelectionTooltipOpen(false)}
          >
            <Badge
              asChild
              className="shrink-0 cursor-default"
              variant="secondary"
            >
              <button
                aria-describedby={selectionTooltipId}
                aria-label={selectionTooltipLabel}
                type="button"
              >
                +{selection.length - 2}
              </button>
            </Badge>
            <span
              aria-hidden={!selectionTooltipOpen}
              className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-[var(--z-tooltip,100700)] max-h-[min(20rem,calc(100vh-96px))] w-max max-w-[min(28rem,calc(100vw-32px))] overflow-auto whitespace-pre-line rounded-md border border-[var(--border-1)] bg-[var(--background-fronted)] px-2 py-1 text-left text-[13px] leading-[1.3] text-[var(--text-primary)] shadow-soft transition-opacity duration-100 [overflow-wrap:anywhere]"
              id={selectionTooltipId}
              role="tooltip"
              style={{
                opacity: selectionTooltipOpen ? 1 : 0,
                visibility: selectionTooltipOpen ? "visible" : "hidden"
              }}
            >
              {selectionTooltipLabel}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          disabled={disabled || loading}
          type="button"
          onClick={onConfirm}
        >
          {loading ? <Spinner className="text-current" size={14} /> : null}
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function Feedback({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4 py-8 text-center text-[13px] text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

/**
 * 文件类型多选筛选(搜索框右侧)。自实现的轻量 popover —— 不用设计系统的 Radix
 * DropdownMenu:本下拉嵌在自定义遮罩对话框(createPortal 到 body)里,Radix 菜单项
 * 的 select 在「portal + modal=false」组合下点击无法触发(hover 高亮正常但点了不勾选),
 * 表现为「筛选选了完全没反应」。改用原生 `<button onClick>`,点击必然触发 toggle。
 *
 * 弹层就地(absolute)渲染在触发器下方、不再 portal:对话框很高、弹层短且贴顶,
 * 不会被 overflow 裁切;省去手动定位与 z 层冲突。未选时按钮显示「全部类型」,已选时
 * 按固定顺序拼出已选分类名(过宽则截断,完整列表见 title 悬浮提示),并附数量徽章。
 *
 * 触发器固定宽度、固定 h-8(与左侧搜索框 Input 同高,父行 items-center 居中对齐):
 * 选中文案再长也只在内部截断成「…」,不撑宽控件、不挤动搜索框。有选中时,触发器右侧的
 * 箭头位让位给「清除」按钮:点击一键清空全部筛选(也可在弹层里逐项取消勾选)。
 */
function FilterCategoryFilter({
  categories,
  copy,
  selected,
  onClear,
  onToggle
}: {
  categories: readonly ReferenceFilterCategory[];
  copy: WorkspaceFileReferenceCopy;
  selected: ReadonlySet<string>;
  onClear: () => void;
  onToggle: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 打开期间:点击容器外部或按 Esc 收起。pointerdown 用捕获阶段,先于其它处理生效;
  // 容器内的点击(触发器/选项)不收起,以支持连续多选。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 按 categories 的固定顺序收集已选标签,保证展示顺序稳定。
  const selectedLabels = categories
    .filter((category) => selected.has(category.id))
    .map((category) => copy.t(category.labelKey));
  const count = selectedLabels.length;
  const labelText =
    count > 0
      ? selectedLabels.join(copy.t("referencePicker.fileTypeSeparator"))
      : copy.t("referencePicker.fileTypeAll");

  return (
    // shrink-0:不被搜索框挤压;固定宽度让控件不随选中文案变宽。
    <div ref={containerRef} className="relative w-[124px] shrink-0">
      <Button
        aria-expanded={open}
        aria-haspopup="menu"
        // h-8:与左侧搜索框(Input size=default 同为 h-8/32px)显式等高对齐。
        // 不用 h-full —— flex 项内的百分比高度无法可靠地依 items-stretch 求值,
        // 会塌到按钮内容高度,导致与搜索框高度不一致。
        // w-full + justify-between:固定宽度容器内,文案占据中间并截断,箭头贴右。
        className="h-8 w-full justify-between gap-1.5 border-0 px-2.5"
        size="default"
        type="button"
        variant="secondary"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left" title={labelText}>
          {labelText}
        </span>
        {count > 1 ? (
          <Badge className="shrink-0 px-1.5" variant="secondary">
            {count}
          </Badge>
        ) : null}
        {count > 0 ? (
          // 有选中时,右侧箭头位让位给「清除」:role=button 的 span(避免 button 嵌
          // button 的非法结构),stopPropagation 让点击只清空筛选、不触发触发器的开合。
          <span
            aria-label={copy.t("referencePicker.clearFilter")}
            className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onClear();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onClear();
              }
            }}
          >
            <CloseIcon size={12} />
          </span>
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
        )}
      </Button>
      {open ? (
        <div
          className="absolute top-[calc(100%+4px)] right-0 min-w-40 overflow-hidden rounded-[8px] border border-[var(--line-1)] bg-[var(--background-fronted)] p-1 shadow-panel"
          role="menu"
          style={{ zIndex: "var(--z-panel-popover)" }}
        >
          {categories.map((category) => {
            const checked = selected.has(category.id);
            return (
              <button
                key={category.id}
                aria-checked={checked}
                className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)]"
                role="menuitemcheckbox"
                type="button"
                onClick={() => onToggle(category.id)}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {checked ? (
                    <CheckIcon className="size-3.5 text-[var(--tutti-purple)]" />
                  ) : null}
                </span>
                <span className="flex-1">{copy.t(category.labelKey)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// 每级缩进 = 箭头列宽(20px)+ 间距(8px)。文件没有箭头列,因此其图标恰好落在
// 父文件夹图标的正下方;更深层级仍逐级缩进以体现层级关系。
const TREE_INDENT = 28;
const TREE_COLLAPSE_DURATION_MS = 200;

function isFocused(
  focused: ReferenceNode | null,
  node: ReferenceNode
): boolean {
  return focused ? nodeRefKey(focused.ref) === nodeRefKey(node.ref) : false;
}

/**
 * 递归文件树节点,交互复刻 main 分支 `WorkspaceFileReferencePickerTreeEntry`:
 * 24px 缩进、folder 箭头旋转、点名称展开/收起、grid-rows 展开动画、add/check 勾选。
 * 可选性由业务侧按 source/kind 注入,例如 host 本地目录可浏览但不可引用。
 */
function TreeNodeRow({
  node,
  depth,
  onContextMenu,
  view,
  copy
}: {
  node: ReferenceNode;
  depth: number;
  onContextMenu: (event: MouseEvent<HTMLElement>, node: ReferenceNode) => void;
  view: PickerView;
  copy: WorkspaceFileReferenceCopy;
}): JSX.Element {
  const key = nodeRefKey(node.ref);
  const isFolder = node.kind === "folder";
  const expanded = view.expandedKeys[key] ?? false;
  const childState = view.childrenByKey[key];
  const childEntries = view.sortNodes(childState?.entries ?? []);
  const selected = view.isSelected(node);
  const selectable = view.isSelectable(node);
  const focused = isFocused(view.focusedNode, node);
  const active = selected || (focused && selectable);
  const focusedRowRef = useRef<HTMLDivElement | null>(null);

  const [shouldRenderChildContent, setShouldRenderChildContent] =
    useState(expanded);

  useEffect(() => {
    if (focused) {
      focusedRowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);

  useEffect(() => {
    if (expanded) {
      setShouldRenderChildContent(true);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setShouldRenderChildContent(false);
    }, TREE_COLLAPSE_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [expanded]);

  const shouldBuildChildContent = expanded || shouldRenderChildContent;
  const childContent = shouldBuildChildContent ? (
    childState?.loading ? (
      <div
        className="flex items-center gap-2 px-2 py-2 text-[11px] text-[var(--text-secondary)]"
        style={{ paddingLeft: `${(depth + 1) * TREE_INDENT + 12}px` }}
      >
        <Spinner className="text-[var(--text-secondary)]" size={14} />
        <span>{copy.t("referencePicker.loading")}</span>
      </div>
    ) : childEntries.length > 0 ? (
      <div className="space-y-0.5">
        {childEntries.map((child) => (
          <TreeNodeRow
            key={nodeRefKey(child.ref)}
            copy={copy}
            depth={depth + 1}
            node={child}
            onContextMenu={onContextMenu}
            view={view}
          />
        ))}
      </div>
    ) : childState?.loaded ? (
      <div
        className="px-2 py-2 text-[11px] text-[var(--text-secondary)]"
        style={{ paddingLeft: `${(depth + 1) * TREE_INDENT + 12}px` }}
      >
        {copy.t("referencePicker.emptyDirectory")}
      </div>
    ) : null
  ) : null;

  return (
    <div>
      {/* 整行可点:点击监听挂在父级行 div 上,使可点热区与 hover 高亮区一致;
          内层箭头/选中按钮 stopPropagation 各管各的,避免冒泡到行点击。 */}
      <div
        ref={focused ? focusedRowRef : undefined}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-[6px] py-1.5 pr-1 transition-colors",
          active ? "bg-transparency-block" : "hover:bg-transparency-block"
        )}
        style={{ paddingLeft: `${depth * TREE_INDENT + 8}px` }}
        onClick={() => {
          view.setFocusedNode(node);
          view.toggleSingleSelectionAndExpand(node);
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
        onDoubleClick={(event) => {
          if (node.kind !== "file") {
            return;
          }
          event.stopPropagation();
          view.setFocusedNode(node);
          void view.openNode(node);
        }}
      >
        {isFolder ? (
          <button
            aria-label={node.displayName}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)]"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              view.setFocusedNode(node);
              view.toggleNode(node);
            }}
          >
            <ArrowRightIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90"
              )}
            />
          </button>
        ) : null}
        {isFolder ? (
          <FolderFilledIcon className="size-4 shrink-0 text-[var(--rich-text-folder)]" />
        ) : (
          <FileIcon className="size-4 shrink-0 text-[var(--text-tertiary)]" />
        )}
        <FullTextTooltip content={node.displayName}>
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]"
            data-autofit-label
          >
            {node.displayName}
          </span>
        </FullTextTooltip>
        {selectable ? (
          <Button
            aria-label={node.displayName}
            aria-pressed={selected}
            className="shrink-0"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              view.setFocusedNode(node);
              view.toggleSelection(node);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {selected ? (
              <CheckIcon size={14} />
            ) : (
              <AddLinedIcon
                className="text-[var(--text-secondary)]"
                size={16}
              />
            )}
          </Button>
        ) : null}
      </div>
      {isFolder ? (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            childContent && "mt-[2px]"
          )}
        >
          <div
            aria-hidden={expanded ? undefined : "true"}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              expanded
                ? "translate-y-0 opacity-100"
                : "-translate-y-1 opacity-0"
            )}
            inert={expanded ? undefined : true}
          >
            {childContent}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function referenceNodeToWorkspaceFileEntry(
  node: ReferenceNode
): WorkspaceFileEntry {
  return {
    hasChildren: node.kind === "folder",
    kind: node.kind === "folder" ? "directory" : "file",
    mtimeMs: node.mtimeMs ?? null,
    name: node.displayName,
    path: nodeRefKey(node.ref),
    sizeBytes: node.sizeBytes ?? null
  };
}

function noopVoid(): void {}

async function noopAsync(): Promise<void> {}
