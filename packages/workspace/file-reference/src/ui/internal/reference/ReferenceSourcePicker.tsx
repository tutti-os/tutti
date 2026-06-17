import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightIcon,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CheckIcon,
  CloseIcon,
  FileIcon,
  FolderFilledIcon,
  Input,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  SearchIcon,
  Spinner,
  cn
} from "@tutti-os/ui-system";
import { AddIcon } from "@tutti-os/ui-system/icons";
import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "../../../contracts/index.ts";
import type { ReferenceSourceAggregator } from "../../../core/referenceSourceAggregator.ts";
import { nodeRefKey } from "../../../core/index.ts";
import { useReferenceSourcePickerView } from "../../../react/internal/reference/useReferenceSourcePickerView.ts";

export interface ReferenceSourcePickerProps {
  aggregator: ReferenceSourceAggregator;
  copy: WorkspaceFileReferenceCopy;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
  open: boolean;
  workspaceId: string;
}

// v1 新增 UI 文案默认中文;后续接入 i18n。
const L = {
  sourceColumn: "分类",
  selectGroupHint: "从左侧选择一个目录",
  previewSource: "产出来源",
  previewModified: "产出时间",
  previewSize: "文件大小",
  previewHierarchy: "所属层级",
  reference: "引用",
  loadMore: "加载更多",
  emptyPreview: "选择一个文件查看详情"
};

type PickerView = ReturnType<typeof useReferenceSourcePickerView>;

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
  onClose,
  onConfirm,
  open,
  workspaceId
}: ReferenceSourcePickerProps): JSX.Element | null {
  const titleId = useId();
  const view = useReferenceSourcePickerView({
    aggregator,
    workspaceId,
    open,
    onClose,
    onConfirm
  });

  // 三栏可拖拽 + 双击自动适配:layoutRef 量整体宽度,content/panel ref 用于双击适配。
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement | null>(null);
  const middleContentRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<ResizablePanelHandle | null>(null);
  const middlePanelRef = useRef<ResizablePanelHandle | null>(null);

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
          <div ref={layoutRef} className="flex min-h-0 flex-1">
            <ResizablePanelGroup
              className="min-h-0 flex-1"
              orientation="horizontal"
              // 三栏初始占比 2:5:3。v4 在三面板下 `defaultSize` 初始布局会因注册时序被忽略而回退等分,
              // 这里用 `defaultLayout`(按 panel id 指定 flexGrow 权重)作为权威初始布局。
              defaultLayout={{ sidebar: 2, middle: 5, preview: 3 }}
            >
              <ResizablePanel
                id="sidebar"
                className="min-h-0 border-r border-[var(--line-1)]"
                defaultSize={20}
                minSize="180px"
                panelRef={(handle) => {
                  sidebarPanelRef.current = handle;
                }}
              >
                <SourceSidebar contentRef={sidebarContentRef} view={view} />
              </ResizablePanel>
              <ResizableHandle
                disableDoubleClick
                withHandle
                onDoubleClick={fitSidebar}
              />
              <ResizablePanel
                id="middle"
                className="min-h-0"
                defaultSize={50}
                minSize="260px"
                panelRef={(handle) => {
                  middlePanelRef.current = handle;
                }}
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex items-center gap-2 border-b border-[var(--line-1)] p-3">
                    <div className="relative flex-1">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
                      <Input
                        className="pl-9"
                        placeholder={copy.t(
                          "referencePicker.searchPlaceholder"
                        )}
                        value={view.searchQuery}
                        onChange={(event) =>
                          view.setSearchQuery(event.target.value)
                        }
                      />
                    </div>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div
                      ref={middleContentRef}
                      className="flex flex-col gap-[2px] p-3"
                    >
                      {view.isLoading ? (
                        <Feedback>
                          <Spinner size={16} />
                        </Feedback>
                      ) : view.isSearch ? (
                        // 搜索:扁平结果
                        view.searchResults.length === 0 ? (
                          <Feedback>
                            {copy.t("referencePicker.emptyDirectory")}
                          </Feedback>
                        ) : (
                          view.searchResults.map((node) => (
                            <SearchResultRow
                              key={nodeRefKey(node.ref)}
                              focused={isFocused(view.focusedNode, node)}
                              node={node}
                              selected={view.isSelected(node)}
                              onFocus={view.setFocusedNode}
                              onToggle={view.toggleSelection}
                            />
                          ))
                        )
                      ) : !hasSelectedGroup ? (
                        <Feedback>{L.selectGroupHint}</Feedback>
                      ) : view.currentEntries.length === 0 ? (
                        <Feedback>
                          {copy.t("referencePicker.emptyDirectory")}
                        </Feedback>
                      ) : (
                        // 浏览:就地递归展开树(复刻 agent 引用面板文件树交互)
                        view.currentEntries.map((node) => (
                          <TreeNodeRow
                            key={nodeRefKey(node.ref)}
                            copy={copy}
                            depth={0}
                            node={node}
                            view={view}
                          />
                        ))
                      )}
                      {view.hasMore && hasSelectedGroup && !view.isSearch ? (
                        <Button
                          className="mt-1 w-full"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={view.loadMore}
                        >
                          {L.loadMore}
                        </Button>
                      ) : null}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>
              <ResizableHandle
                disableDoubleClick
                withHandle
                onDoubleClick={fitMiddle}
              />
              <ResizablePanel
                id="preview"
                className="min-h-0 border-l border-[var(--line-1)]"
                defaultSize={30}
                minSize="200px"
              >
                <PreviewInfoPane
                  node={view.focusedNode}
                  sourceLabel={view.activeTabLabel}
                  hierarchy={view.breadcrumb}
                  onReference={view.toggleSelection}
                  referenced={
                    view.focusedNode ? view.isSelected(view.focusedNode) : false
                  }
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
 * 左侧两级分栏(类 macOS Finder 边栏):
 * 一级 = 各引用源(本地/应用/issue),可多源同时展开;二级 = 该源根下的目录分组。
 */
function SourceSidebar({
  view,
  contentRef
}: {
  view: PickerView;
  contentRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <ScrollArea className="h-full min-h-0 w-full">
      <div ref={contentRef} className="flex flex-col gap-0.5 p-2">
        <p className="px-2 py-1 text-[11px] font-semibold text-[var(--text-tertiary)]">
          {L.sourceColumn}
        </p>
        {view.tabs.map((tab) => {
          const active = tab.sourceId === view.activeSourceId;
          const expanded = view.isSourceExpanded(tab.sourceId);
          const groups = view.sidebarGroupsBySource[tab.sourceId] ?? [];
          return (
            <div key={tab.sourceId} className="flex flex-col gap-0.5">
              <button
                aria-expanded={expanded}
                className={cn(
                  "flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] font-semibold transition-colors hover:bg-transparency-block",
                  active
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                )}
                type="button"
                onClick={() => view.toggleSourceExpanded(tab.sourceId)}
              >
                <ArrowRightIcon
                  className={cn(
                    "size-3 shrink-0 text-[var(--text-tertiary)] transition-transform",
                    expanded && "rotate-90"
                  )}
                />
                <span className="truncate" data-autofit-label>
                  {tab.label}
                </span>
              </button>
              {expanded ? (
                <div className="flex flex-col gap-0.5">
                  {groups.length === 0 ? (
                    <p className="px-2 py-1.5 pl-7 text-[12px] text-[var(--text-tertiary)]">
                      {view.isLoadingTabs ? "…" : ""}
                    </p>
                  ) : (
                    groups.map((group) => {
                      const key = nodeRefKey(group.ref);
                      const selected = key === view.selectedGroupKey;
                      return (
                        <button
                          key={key}
                          className={cn(
                            "flex items-center gap-2 rounded-[6px] py-1.5 pr-2 pl-7 text-left text-[13px] transition-colors hover:bg-transparency-block",
                            selected
                              ? "bg-transparency-block text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)]"
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
                            <FolderFilledIcon className="size-4 shrink-0 text-[var(--rich-text-folder)]" />
                          )}
                          <span
                            className="min-w-0 flex-1 truncate"
                            data-autofit-label
                          >
                            {group.displayName}
                          </span>
                          {group.childCount != null ? (
                            <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                              {group.childCount}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  )}
                </div>
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
  onFocus,
  onToggle
}: {
  node: ReferenceNode;
  focused: boolean;
  selected: boolean;
  onFocus: (node: ReferenceNode) => void;
  onToggle: (node: ReferenceNode) => void;
}): JSX.Element {
  const isFolder = node.kind === "folder";
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[6px] border py-2.5 pr-1 pl-3 transition-colors",
        focused || selected
          ? "border-border bg-transparency-block"
          : "border-transparent bg-transparent hover:border-border/70 hover:bg-transparency-block"
      )}
    >
      <button
        className="flex min-w-0 items-center gap-3 text-left"
        type="button"
        onClick={() => onFocus(node)}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--transparency-block)] text-[var(--text-tertiary)]">
          {isFolder ? (
            <FolderFilledIcon className="size-4 text-[var(--rich-text-folder)]" />
          ) : (
            <FileIcon className="size-4 text-[var(--text-tertiary)]" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
            {node.displayName}
          </span>
          <span className="block truncate text-[11px] text-[var(--text-secondary)]">
            {node.ref.nodeId}
          </span>
        </span>
      </button>
      <Button
        aria-label={node.displayName}
        aria-pressed={selected}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() => {
          onFocus(node);
          onToggle(node);
        }}
      >
        {selected ? (
          <CheckIcon size={14} />
        ) : (
          <AddIcon className="text-[var(--text-secondary)]" size={16} />
        )}
      </Button>
    </div>
  );
}

function PreviewInfoPane({
  node,
  sourceLabel,
  hierarchy,
  referenced,
  onReference
}: {
  node: ReferenceNode | null;
  sourceLabel: string;
  hierarchy: readonly ReferenceNode[];
  referenced: boolean;
  onReference: (node: ReferenceNode) => void;
}): JSX.Element {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-[var(--background-fronted)]">
      {node ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <div className="grid aspect-[3/2] w-full place-items-center rounded-[8px] border border-[var(--line-2,var(--border-2))] bg-[var(--transparency-block)]">
            <FileIcon className="size-9 text-[var(--text-tertiary)]" />
          </div>
          <p className="truncate text-[15px] font-semibold">
            {node.displayName}
          </p>
          <dl className="space-y-2 text-[13px]">
            <InfoRow label={L.previewSource}>
              <Badge variant="secondary">{sourceLabel}</Badge>
            </InfoRow>
            {node.mtimeMs != null ? (
              <InfoRow label={L.previewModified}>
                {formatDateTime(node.mtimeMs)}
              </InfoRow>
            ) : null}
            {node.sizeBytes != null ? (
              <InfoRow label={L.previewSize}>
                {formatBytes(node.sizeBytes)}
              </InfoRow>
            ) : null}
          </dl>
          {hierarchy.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-[var(--text-tertiary)]">
                {L.previewHierarchy}
              </p>
              <div className="flex flex-wrap gap-1">
                {hierarchy.map((crumb) => (
                  <Badge key={nodeRefKey(crumb.ref)} variant="secondary">
                    {crumb.displayName}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-auto flex justify-end">
            <Button
              type="button"
              variant={referenced ? "secondary" : undefined}
              onClick={() => onReference(node)}
            >
              {L.reference}
            </Button>
          </div>
        </div>
      ) : (
        <Feedback>{L.emptyPreview}</Feedback>
      )}
    </aside>
  );
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
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--line-1)] px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[13px] text-[var(--text-secondary)]">
          {countLabel}
        </span>
        {selection.slice(0, 2).map((node) => (
          <Badge key={nodeRefKey(node.ref)} variant="secondary">
            <span className="truncate">{node.displayName}</span>
          </Badge>
        ))}
        {selection.length > 2 ? (
          <Badge variant="secondary">+{selection.length - 2}</Badge>
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
 * 24px 缩进、folder 箭头旋转、点名称展开/收起、grid-rows 展开动画、add/check 勾选
 * (文件夹与文件都可作为引用选中)。
 */
function TreeNodeRow({
  node,
  depth,
  view,
  copy
}: {
  node: ReferenceNode;
  depth: number;
  view: PickerView;
  copy: WorkspaceFileReferenceCopy;
}): JSX.Element {
  const key = nodeRefKey(node.ref);
  const isFolder = node.kind === "folder";
  const expanded = view.expandedKeys[key] ?? false;
  const childState = view.childrenByKey[key];
  const childEntries = view.sortNodes(childState?.entries ?? []);
  const selected = view.isSelected(node);
  const focused = isFocused(view.focusedNode, node);

  const [shouldRenderChildContent, setShouldRenderChildContent] =
    useState(expanded);

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
      <div
        className={cn(
          "flex items-center gap-2 rounded-[6px] py-1.5 pr-1 transition-colors",
          focused || selected
            ? "bg-transparency-block"
            : "hover:bg-transparency-block"
        )}
        style={{ paddingLeft: `${depth * TREE_INDENT + 8}px` }}
      >
        {isFolder ? (
          <button
            aria-label={node.displayName}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)]"
            type="button"
            onClick={() => view.toggleNode(node)}
          >
            <ArrowRightIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-90"
              )}
            />
          </button>
        ) : null}
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          type="button"
          onClick={() => {
            view.setFocusedNode(node);
            if (isFolder) {
              view.toggleNode(node);
            }
          }}
        >
          {isFolder ? (
            <FolderFilledIcon className="size-4 shrink-0 text-[var(--rich-text-folder)]" />
          ) : (
            <FileIcon className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          )}
          <span
            className="truncate text-[13px] text-[var(--text-primary)]"
            data-autofit-label
          >
            {node.displayName}
          </span>
        </button>
        <Button
          aria-label={node.displayName}
          aria-pressed={selected}
          className="shrink-0"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => {
            view.setFocusedNode(node);
            view.toggleSelection(node);
          }}
        >
          {selected ? (
            <CheckIcon size={14} />
          ) : (
            <AddIcon className="text-[var(--text-secondary)]" size={16} />
          )}
        </Button>
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

function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
