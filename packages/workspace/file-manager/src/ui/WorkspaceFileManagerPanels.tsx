import {
  ArrowRightIcon,
  FileCodeIcon,
  FileTextIcon,
  LoadingIcon,
  ScrollArea,
  VideoFileIcon,
  cn
} from "@tutti-os/ui-system";
import type { TuttiDateLocale } from "@tutti-os/ui-system/date-format";
import { resolveWorkspaceFileVisualKind } from "@tutti-os/workspace-file-preview";
import { WorkspaceFilePreviewSurface as SharedWorkspaceFilePreviewSurface } from "@tutti-os/workspace-file-preview/react";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  RefObject
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  formatWorkspaceFileBytes,
  formatWorkspaceFileModifiedTime,
  splitWorkspaceFileName
} from "../services/workspaceFileManagerModel.ts";
import type {
  WorkspaceFileActivationTarget,
  WorkspaceFileEntry,
  WorkspaceFileManagerInlineRenameValidation,
  WorkspaceFilePreviewState
} from "../services/workspaceFileManagerTypes.ts";
import { WorkspaceFileManagerIconGrid } from "./WorkspaceFileManagerIconGrid.tsx";
import {
  WorkspaceFileEntryIcon,
  WorkspaceFolderFallbackIcon,
  WorkspaceImageFallbackIcon
} from "./WorkspaceFileEntryIcon.tsx";
import {
  resolveWorkspaceFileEntryArrangeDateMs,
  type WorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";
import {
  readWorkspaceFileManagerPreviewWidth,
  workspaceFileManagerPaneResizeStep,
  workspaceFileManagerPreviewDefaultWidth,
  writeWorkspaceFileManagerPreviewWidth
} from "./workspaceFileManagerPaneSizing.ts";
import type { WorkspaceFileManagerVisibleTreeRow } from "./workspaceFileManagerVisibleTree.ts";
import {
  workspaceFileManagerCompactTableGridClassName,
  workspaceFileManagerCompactTableGridTemplate,
  workspaceFileManagerTableGridClassName,
  workspaceFileManagerTableGridTemplate
} from "./workspaceFileManagerTableSizing.ts";

const workspaceFileManagerTableGridStyle: CSSProperties = {
  gridTemplateColumns: workspaceFileManagerTableGridTemplate
};
const workspaceFileManagerCompactTableGridStyle: CSSProperties = {
  gridTemplateColumns: workspaceFileManagerCompactTableGridTemplate
};
const workspaceFileManagerPreviewDetailGridStyle: CSSProperties = {
  gridTemplateColumns: "minmax(82px, 0.8fr) minmax(0, 1.2fr)"
};
const workspaceFileManagerStackedBreakpoint = 600;
const workspaceFileManagerPreviewMinWidth = 220;
const workspaceFileManagerTableMinWidth = 360;
const workspaceFileManagerMoveDragThreshold = 4;
const workspaceFileManagerMoveDragAutoScrollDelayMs = 500;
const workspaceFileManagerMoveDragAutoScrollEdgePx = 48;
const workspaceFileManagerMoveDragAutoScrollStepPx = 12;
const workspaceFileManagerEntryOpenClickIntervalMs = 500;

export type WorkspaceFileManagerEntryDragMode = "external" | "internal-move";

export function WorkspaceFileManagerPanels({
  arrangeMode,
  canMove,
  contextMenuEntryPath,
  dateLocale,
  entryDragMode,
  entrySelectionEnabled = true,
  entryContextByPath = null,
  copy,
  iconUrlByCacheKey,
  inlineRenameEntryPath,
  inlineRenameValidation,
  isRenaming,
  layoutMode,
  pendingDirectoryPath,
  previewState,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter,
  selectedEntry,
  selectedPath,
  showPreviewPanel: showPreviewPanelEnabled = true,
  state,
  treeRows,
  onBlankContextMenu,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename,
  onEntryContextMenu,
  onEntryDragStart,
  onMoveEntry,
  onOpenEntry,
  onSelect,
  onToggleDirectoryExpanded
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  canMove: boolean;
  contextMenuEntryPath: string | null;
  dateLocale?: TuttiDateLocale;
  entryDragMode?: WorkspaceFileManagerEntryDragMode;
  entrySelectionEnabled?: boolean;
  entryContextByPath?: ReadonlyMap<string, string> | null;
  copy: WorkspaceFileManagerI18nRuntime;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  inlineRenameEntryPath: string | null;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  isRenaming: boolean;
  layoutMode: WorkspaceFileManagerLayoutMode;
  pendingDirectoryPath: string | null;
  previewState: WorkspaceFilePreviewState;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
  selectedEntry: WorkspaceFileEntry | null;
  selectedPath: string | null;
  showPreviewPanel?: boolean;
  state: {
    entries: readonly WorkspaceFileEntry[];
    error: string | null;
    isLoading: boolean;
    isSearchMode: boolean;
  };
  treeRows: readonly WorkspaceFileManagerVisibleTreeRow[];
  onBlankContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
  onEntryContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry
  ) => void;
  onEntryDragStart?: (
    entry: WorkspaceFileEntry,
    dataTransfer: DataTransfer
  ) => void;
  onMoveEntry: (entry: WorkspaceFileEntry, targetDirectoryPath: string) => void;
  onOpenEntry: (entry: WorkspaceFileEntry) => void;
  onSelect: (path: string) => void;
  onToggleDirectoryExpanded: (
    entry: WorkspaceFileEntry,
    expanded: boolean
  ) => void;
}): ReactElement {
  const { rootRef } = useWorkspaceFileManagerStackedLayout(
    workspaceFileManagerStackedBreakpoint
  );
  const previewResizeRef = useRef<{
    currentWidth: number;
    pointerId: number;
    startX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);
  const [previewPaneWidth, setPreviewPaneWidth] = useState(
    readWorkspaceFileManagerPreviewWidth
  );
  const [previewPaneMaxWidth, setPreviewPaneMaxWidth] = useState(
    workspaceFileManagerPreviewDefaultWidth
  );
  const [moveDragPreview, setMoveDragPreview] =
    useState<WorkspaceFileManagerMoveDragPreview | null>(null);
  const lastEntryClickRef = useRef<{ path: string; timeMs: number } | null>(
    null
  );
  const moveDragAutoScrollRef =
    useRef<WorkspaceFileManagerMoveDragAutoScroll | null>(null);
  const moveDragRef = useRef<WorkspaceFileManagerMoveDrag | null>(null);
  const suppressNextClickRef = useRef(false);
  const moveTargetEntries = useMemo(
    () =>
      layoutMode === "list"
        ? treeRows.flatMap((row) => (row.kind === "entry" ? [row.entry] : []))
        : state.entries,
    [layoutMode, state.entries, treeRows]
  );
  const entriesRef = useRef<readonly WorkspaceFileEntry[]>(moveTargetEntries);
  const nativeEntryDragEnabled =
    onEntryDragStart !== undefined &&
    (entryDragMode === "external" || (entryDragMode === undefined && !canMove));
  const internalMoveEnabled = canMove && !nativeEntryDragEnabled;
  const dateColumnLabel = resolveWorkspaceFileManagerDateColumnLabel(
    copy,
    arrangeMode
  );
  const stopMoveDragAutoScroll = useCallback((): void => {
    const autoScroll = moveDragAutoScrollRef.current;
    if (autoScroll?.frameId !== null && autoScroll?.frameId !== undefined) {
      window.cancelAnimationFrame(autoScroll.frameId);
    }
    moveDragAutoScrollRef.current = null;
  }, []);
  const updateMoveDragAutoScroll = useCallback(
    (clientY: number): void => {
      const scrollViewport = resolveWorkspaceFileManagerTableScrollViewport(
        rootRef.current
      );
      const direction = resolveWorkspaceFileManagerMoveDragAutoScrollDirection(
        scrollViewport,
        clientY
      );
      if (!scrollViewport || direction === null) {
        stopMoveDragAutoScroll();
        return;
      }

      const current = moveDragAutoScrollRef.current;
      if (
        current?.scrollViewport === scrollViewport &&
        current.direction === direction
      ) {
        current.lastClientY = clientY;
        return;
      }

      stopMoveDragAutoScroll();

      const nextAutoScroll: WorkspaceFileManagerMoveDragAutoScroll = {
        direction,
        enteredAtMs: window.performance.now(),
        frameId: null,
        lastClientY: clientY,
        scrollViewport
      };

      const step = (timestamp: number) => {
        if (moveDragAutoScrollRef.current !== nextAutoScroll) {
          return;
        }

        const nextDirection =
          resolveWorkspaceFileManagerMoveDragAutoScrollDirection(
            nextAutoScroll.scrollViewport,
            nextAutoScroll.lastClientY
          );
        if (nextDirection !== nextAutoScroll.direction) {
          stopMoveDragAutoScroll();
          return;
        }

        if (
          timestamp - nextAutoScroll.enteredAtMs >=
          workspaceFileManagerMoveDragAutoScrollDelayMs
        ) {
          nextAutoScroll.scrollViewport.scrollTop +=
            nextAutoScroll.direction *
            workspaceFileManagerMoveDragAutoScrollStepPx;
        }

        nextAutoScroll.frameId = window.requestAnimationFrame(step);
      };

      moveDragAutoScrollRef.current = nextAutoScroll;
      nextAutoScroll.frameId = window.requestAnimationFrame(step);
    },
    [rootRef, stopMoveDragAutoScroll]
  );
  const handleEntryPointerDown = useCallback(
    (entry: WorkspaceFileEntry, event: ReactPointerEvent<HTMLElement>) => {
      if (!internalMoveEnabled || event.button !== 0) {
        return;
      }

      moveDragRef.current = {
        active: false,
        entry,
        startX: event.clientX,
        startY: event.clientY
      };
    },
    [internalMoveEnabled]
  );
  const shouldSuppressEntryClick = useCallback((): boolean => {
    if (!suppressNextClickRef.current) {
      return false;
    }
    suppressNextClickRef.current = false;
    return true;
  }, []);
  const handleTablePanelContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-workspace-file-entry-path]")
      ) {
        return;
      }
      onBlankContextMenu(event);
    },
    [onBlankContextMenu]
  );
  const handleEntryClick = useCallback(
    (entry: WorkspaceFileEntry): void => {
      if (shouldSuppressEntryClick()) {
        lastEntryClickRef.current = null;
        return;
      }

      const now = Date.now();
      const lastClick = lastEntryClickRef.current;
      if (
        lastClick?.path === entry.path &&
        now - lastClick.timeMs <= workspaceFileManagerEntryOpenClickIntervalMs
      ) {
        lastEntryClickRef.current = null;
        onOpenEntry(entry);
        return;
      }

      lastEntryClickRef.current = { path: entry.path, timeMs: now };
      if (!entrySelectionEnabled) {
        return;
      }
      onSelect(entry.path);
    },
    [entrySelectionEnabled, onOpenEntry, onSelect, shouldSuppressEntryClick]
  );
  useEffect(() => {
    lastEntryClickRef.current = null;
    entriesRef.current = moveTargetEntries;
  }, [moveTargetEntries]);
  useEffect(() => {
    function handleDocumentPointerMove(event: PointerEvent | MouseEvent): void {
      const drag = moveDragRef.current;
      if (!drag) {
        return;
      }

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (
        !drag.active &&
        Math.hypot(deltaX, deltaY) >= workspaceFileManagerMoveDragThreshold
      ) {
        drag.active = true;
      }
      if (drag.active) {
        const targetEntry = resolveMoveDragTargetEntry(
          entriesRef.current,
          drag.entry,
          event.clientX,
          event.clientY
        );
        setMoveDragPreview({
          entry: drag.entry,
          targetDirectoryPath: targetEntry?.path ?? null,
          x: event.clientX,
          y: event.clientY
        });
        updateMoveDragAutoScroll(event.clientY);
        event.preventDefault();
      }
    }

    function handleDocumentPointerUp(event: PointerEvent | MouseEvent): void {
      const drag = moveDragRef.current;
      moveDragRef.current = null;
      stopMoveDragAutoScroll();
      setMoveDragPreview(null);
      if (!drag?.active) {
        return;
      }

      suppressNextClickRef.current = true;
      event.preventDefault();
      if (!internalMoveEnabled) {
        return;
      }

      const targetEntry = resolveMoveDragTargetEntry(
        entriesRef.current,
        drag.entry,
        event.clientX,
        event.clientY
      );
      if (targetEntry) {
        onMoveEntry(drag.entry, targetEntry.path);
      }
    }

    document.addEventListener("pointermove", handleDocumentPointerMove, true);
    document.addEventListener("mousemove", handleDocumentPointerMove, true);
    document.addEventListener("pointerup", handleDocumentPointerUp, true);
    document.addEventListener("mouseup", handleDocumentPointerUp, true);
    return () => {
      document.removeEventListener(
        "pointermove",
        handleDocumentPointerMove,
        true
      );
      document.removeEventListener(
        "mousemove",
        handleDocumentPointerMove,
        true
      );
      document.removeEventListener("pointerup", handleDocumentPointerUp, true);
      document.removeEventListener("mouseup", handleDocumentPointerUp, true);
      stopMoveDragAutoScroll();
    };
  }, [
    internalMoveEnabled,
    onMoveEntry,
    stopMoveDragAutoScroll,
    updateMoveDragAutoScroll
  ]);
  const showPreviewPanel = showPreviewPanelEnabled && layoutMode === "list";
  const useStackedPreview = false;
  const previewPaneClassName = useStackedPreview
    ? "min-w-0 border-t border-[var(--border-1)]"
    : "min-w-[220px] border-l border-[var(--border-1)]";
  const tableGridClassName = useStackedPreview
    ? workspaceFileManagerCompactTableGridClassName
    : workspaceFileManagerTableGridClassName;
  const tableGridStyle = useStackedPreview
    ? workspaceFileManagerCompactTableGridStyle
    : workspaceFileManagerTableGridStyle;
  const tableCellPaddingClassName = "px-4";
  const clampPreviewPaneWidth = useCallback(
    (width: number, maxWidth?: number): number => {
      const resolvedMaxWidth =
        typeof maxWidth === "number"
          ? Math.max(workspaceFileManagerPreviewMinWidth, maxWidth)
          : Number.POSITIVE_INFINITY;
      return Math.min(
        Math.max(width, workspaceFileManagerPreviewMinWidth),
        resolvedMaxWidth
      );
    },
    []
  );
  const resolvePreviewPaneMaxWidth = useCallback((): number => {
    const containerWidth =
      rootRef.current?.getBoundingClientRect().width ??
      workspaceFileManagerTableMinWidth + workspaceFileManagerPreviewMinWidth;
    return Math.max(
      workspaceFileManagerPreviewMinWidth,
      containerWidth - workspaceFileManagerTableMinWidth
    );
  }, [rootRef]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || useStackedPreview || !showPreviewPanel) {
      return;
    }

    const publishLayout = () => {
      const maxWidth = resolvePreviewPaneMaxWidth();
      setPreviewPaneMaxWidth(maxWidth);
      setPreviewPaneWidth((currentWidth) =>
        clampPreviewPaneWidth(currentWidth, maxWidth)
      );
    };

    publishLayout();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", publishLayout);
      return () => {
        window.removeEventListener("resize", publishLayout);
      };
    }

    const observer = new ResizeObserver(publishLayout);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [
    clampPreviewPaneWidth,
    resolvePreviewPaneMaxWidth,
    rootRef,
    showPreviewPanel,
    useStackedPreview
  ]);

  const handlePreviewResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }

      const maxWidth = resolvePreviewPaneMaxWidth();
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      previewResizeRef.current = {
        currentWidth: previewPaneWidth,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: previewPaneWidth,
        maxWidth
      };
    },
    [previewPaneWidth, resolvePreviewPaneMaxWidth]
  );

  const handlePreviewResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const resize = previewResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - resize.startX;
      resize.currentWidth = clampPreviewPaneWidth(
        resize.startWidth - deltaX,
        resize.maxWidth
      );
      setPreviewPaneWidth(resize.currentWidth);
    },
    [clampPreviewPaneWidth]
  );

  const handlePreviewResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const resize = previewResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }

      previewResizeRef.current = null;
      writeWorkspaceFileManagerPreviewWidth(resize.currentWidth);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    []
  );
  const handlePreviewResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      let nextWidth: number | null = null;
      if (event.key === "Home") {
        event.preventDefault();
        nextWidth = workspaceFileManagerPreviewMinWidth;
      } else if (event.key === "End") {
        event.preventDefault();
        nextWidth = previewPaneMaxWidth;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nextWidth = clampPreviewPaneWidth(
          previewPaneWidth +
            (event.key === "ArrowLeft"
              ? workspaceFileManagerPaneResizeStep
              : -workspaceFileManagerPaneResizeStep),
          previewPaneMaxWidth
        );
      }
      if (nextWidth !== null) {
        setPreviewPaneWidth(nextWidth);
        writeWorkspaceFileManagerPreviewWidth(nextWidth);
      }
    },
    [clampPreviewPaneWidth, previewPaneMaxWidth, previewPaneWidth]
  );

  const tablePanel = (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        useStackedPreview ? "h-[44%] max-h-[48%] flex-none" : "flex-1"
      )}
      onContextMenu={handleTablePanelContextMenu}
    >
      {state.error ? (
        <FeedbackState message={state.error} />
      ) : state.isLoading && state.entries.length === 0 ? (
        <FeedbackState message={copy.t("loading")} />
      ) : state.entries.length === 0 ? (
        <FeedbackState
          message={copy.t(
            state.isSearchMode ? "noSearchResults" : "emptyDirectory"
          )}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1 [&_[data-orientation=vertical][data-slot=scroll-area-scrollbar]]:opacity-100">
          {layoutMode === "icon" ? (
            <WorkspaceFileManagerIconGrid
              contextMenuEntryPath={contextMenuEntryPath}
              copy={copy}
              draggable={nativeEntryDragEnabled}
              entries={state.entries}
              iconUrlByCacheKey={iconUrlByCacheKey}
              inlineRenameEntryPath={inlineRenameEntryPath}
              inlineRenameValidation={inlineRenameValidation}
              isRenaming={isRenaming}
              moveDragActive={moveDragPreview !== null}
              moveDragPreviewEntryPath={moveDragPreview?.entry.path ?? null}
              moveDragTargetEntryPath={
                moveDragPreview?.targetDirectoryPath ?? null
              }
              pendingDirectoryPath={pendingDirectoryPath}
              onEntryIconViewportLeave={onEntryIconViewportLeave}
              onEntryIconViewportEnter={onEntryIconViewportEnter}
              selectedPath={selectedPath}
              onCancelInlineRename={onCancelInlineRename}
              onClearInlineRenameValidation={onClearInlineRenameValidation}
              onConfirmInlineRename={onConfirmInlineRename}
              onContextMenu={onEntryContextMenu}
              onDragStart={onEntryDragStart}
              onEntryClick={handleEntryClick}
              onEntryPointerDown={handleEntryPointerDown}
            />
          ) : (
            <div className="flex flex-col">
              <div
                className={cn(
                  "grid h-9 min-h-9 items-center gap-x-6 border-b border-[var(--border-1)] text-xs font-normal text-[var(--text-secondary)]",
                  tableGridClassName
                )}
                style={tableGridStyle}
              >
                <span
                  className={cn(
                    "min-w-0 overflow-hidden",
                    tableCellPaddingClassName
                  )}
                  data-workspace-file-manager-name-column=""
                >
                  {copy.t("nameLabel")}
                </span>
                <span
                  className={cn("min-w-0 truncate", tableCellPaddingClassName)}
                >
                  {dateColumnLabel}
                </span>
                <span
                  className={cn("min-w-0 truncate", tableCellPaddingClassName)}
                >
                  {copy.t("sizeLabel")}
                </span>
              </div>
              {treeRows.map((row) =>
                row.kind === "feedback" ? (
                  <TreeFeedbackRow
                    key={row.key}
                    copy={copy}
                    depth={row.depth}
                    gridClassName={tableGridClassName}
                    gridStyle={tableGridStyle}
                    message={row.message}
                    status={row.status}
                    tableCellPaddingClassName={tableCellPaddingClassName}
                  />
                ) : (
                  <EntryRow
                    key={row.entry.path}
                    contextMenuActive={contextMenuEntryPath === row.entry.path}
                    copy={copy}
                    arrangeMode={arrangeMode}
                    dateLocale={dateLocale}
                    depth={row.depth}
                    entry={row.entry}
                    contextLabel={entryContextByPath?.get(row.entry.path)}
                    expanded={row.expanded}
                    expandable={row.expandable}
                    iconUrlByCacheKey={iconUrlByCacheKey}
                    canMove={internalMoveEnabled}
                    draggable={nativeEntryDragEnabled}
                    gridClassName={tableGridClassName}
                    gridStyle={tableGridStyle}
                    inlineRenameValidation={
                      inlineRenameEntryPath === row.entry.path
                        ? inlineRenameValidation
                        : null
                    }
                    isEnteringDirectory={
                      pendingDirectoryPath === row.entry.path
                    }
                    isInlineRenaming={inlineRenameEntryPath === row.entry.path}
                    isLoadingChildren={row.loadingChildren}
                    isRenaming={isRenaming}
                    moveDragActive={moveDragPreview !== null}
                    moveDragSource={
                      moveDragPreview?.entry.path === row.entry.path
                    }
                    moveDragTarget={
                      moveDragPreview?.targetDirectoryPath === row.entry.path
                    }
                    tableCellPaddingClassName={tableCellPaddingClassName}
                    selected={selectedPath === row.entry.path}
                    onEntryIconViewportLeave={onEntryIconViewportLeave}
                    onEntryIconViewportEnter={onEntryIconViewportEnter}
                    onCancelInlineRename={onCancelInlineRename}
                    onClearInlineRenameValidation={
                      onClearInlineRenameValidation
                    }
                    onConfirmInlineRename={onConfirmInlineRename}
                    onContextMenu={onEntryContextMenu}
                    onDragStart={onEntryDragStart}
                    onClick={handleEntryClick}
                    onPointerDown={handleEntryPointerDown}
                    onToggleDirectoryExpanded={onToggleDirectoryExpanded}
                  />
                )
              )}
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );

  const previewPanel = showPreviewPanel ? (
    <aside
      className={cn(
        "relative flex h-full min-h-0 flex-col gap-[14px] overflow-auto p-4",
        useStackedPreview ? "max-h-[44%] flex-none" : "flex-none",
        previewPaneClassName
      )}
      style={
        useStackedPreview
          ? undefined
          : ({ width: previewPaneWidth } satisfies CSSProperties)
      }
    >
      <PreviewPane
        copy={copy}
        dateLocale={dateLocale}
        entry={selectedEntry}
        previewState={previewState}
      />
    </aside>
  ) : null;

  return (
    <div
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      ref={rootRef}
    >
      <div
        className={cn(
          "h-full min-h-0 min-w-0 bg-transparent",
          useStackedPreview ? "flex flex-col gap-3" : "flex"
        )}
      >
        {tablePanel}
        {showPreviewPanel && !useStackedPreview ? (
          <div
            aria-label={copy.t("resizePreviewPanel")}
            aria-orientation="vertical"
            aria-valuemax={previewPaneMaxWidth}
            aria-valuemin={workspaceFileManagerPreviewMinWidth}
            aria-valuenow={previewPaneWidth}
            className="nodrag absolute top-0 bottom-0 z-[1] w-2 cursor-col-resize touch-none"
            role="separator"
            tabIndex={0}
            style={
              {
                right: previewPaneWidth - 4
              } satisfies CSSProperties
            }
            onPointerCancel={handlePreviewResizePointerEnd}
            onPointerDown={handlePreviewResizePointerDown}
            onPointerMove={handlePreviewResizePointerMove}
            onPointerUp={handlePreviewResizePointerEnd}
            onKeyDown={handlePreviewResizeKeyDown}
          />
        ) : null}
        {previewPanel}
      </div>
      {moveDragPreview ? (
        <MoveDragPreview
          iconUrlByCacheKey={iconUrlByCacheKey}
          preview={moveDragPreview}
          onEntryIconViewportLeave={onEntryIconViewportLeave}
          onEntryIconViewportEnter={onEntryIconViewportEnter}
        />
      ) : null}
    </div>
  );
}

function useWorkspaceFileManagerStackedLayout(breakpoint: number): {
  isStacked: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
} {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isStacked, setIsStacked] = useState(false);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }

    const publishLayout = () => {
      const nextIsStacked =
        Math.round(element.getBoundingClientRect().width) <= breakpoint;
      setIsStacked((current) =>
        current === nextIsStacked ? current : nextIsStacked
      );
    };

    publishLayout();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", publishLayout);
      return () => {
        window.removeEventListener("resize", publishLayout);
      };
    }

    const observer = new ResizeObserver(publishLayout);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [breakpoint]);

  return { isStacked, rootRef };
}

function resolveWorkspaceFileManagerDateColumnLabel(
  copy: WorkspaceFileManagerI18nRuntime,
  arrangeMode: WorkspaceFileManagerArrangeMode
): string {
  switch (arrangeMode) {
    case "lastOpened":
      return copy.t("arrangeLastOpenedLabel");
    case "dateAdded":
      return copy.t("arrangeDateAddedLabel");
    case "created":
      return copy.t("arrangeCreatedLabel");
    case "modified":
    default:
      return copy.t("modifiedLabel");
  }
}

function EntryRow({
  arrangeMode,
  canMove,
  contextMenuActive,
  contextLabel,
  copy,
  dateLocale,
  depth,
  draggable,
  entry,
  expanded,
  expandable,
  gridClassName,
  gridStyle,
  iconUrlByCacheKey,
  inlineRenameValidation,
  isEnteringDirectory,
  isInlineRenaming,
  isLoadingChildren,
  isRenaming,
  moveDragActive,
  moveDragSource,
  moveDragTarget,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter,
  selected,
  tableCellPaddingClassName,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename,
  onContextMenu,
  onDragStart,
  onClick,
  onPointerDown,
  onToggleDirectoryExpanded
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  canMove: boolean;
  contextMenuActive: boolean;
  contextLabel?: string | null;
  copy: WorkspaceFileManagerI18nRuntime;
  dateLocale?: TuttiDateLocale;
  depth: number;
  draggable: boolean;
  entry: WorkspaceFileEntry;
  expanded: boolean;
  expandable: boolean;
  gridClassName: string;
  gridStyle: CSSProperties;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  isEnteringDirectory: boolean;
  isInlineRenaming: boolean;
  isLoadingChildren: boolean;
  isRenaming: boolean;
  moveDragActive: boolean;
  moveDragSource: boolean;
  moveDragTarget: boolean;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry
  ) => void;
  onDragStart?: (entry: WorkspaceFileEntry, dataTransfer: DataTransfer) => void;
  onClick: (entry: WorkspaceFileEntry) => void;
  onPointerDown: (
    entry: WorkspaceFileEntry,
    event: ReactPointerEvent<HTMLElement>
  ) => void;
  onToggleDirectoryExpanded: (
    entry: WorkspaceFileEntry,
    expanded: boolean
  ) => void;
  selected: boolean;
  tableCellPaddingClassName: string;
}): ReactElement {
  const buttonRowRef = useRef<HTMLButtonElement | null>(null);
  const divRowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!selected) {
      return;
    }
    (buttonRowRef.current ?? divRowRef.current)?.scrollIntoView({
      block: "nearest",
      inline: "nearest"
    });
  }, [selected]);

  const rowClassName = cn(
    "relative grid min-h-10 w-full items-center gap-x-6 border-b border-[var(--border-1)] px-0 text-left transition-colors",
    gridClassName,
    isInlineRenaming
      ? "cursor-default"
      : "cursor-pointer hover:bg-transparency-hover active:bg-[var(--transparency-active)]",
    canMove && moveDragActive && "cursor-grabbing",
    selected || contextMenuActive || isInlineRenaming
      ? "bg-transparency-block text-[var(--text-primary)]"
      : "text-[var(--text-secondary)]",
    moveDragSource && "opacity-55",
    moveDragTarget &&
      "bg-[var(--accent-bg)] text-[var(--text-primary)] outline outline-1 -outline-offset-1 outline-[var(--border-focus)]",
    moveDragActive && !moveDragSource && !moveDragTarget && "opacity-90"
  );
  const rowProps = {
    className: rowClassName,
    "data-workspace-file-entry-path": entry.path,
    style: gridStyle,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      onContextMenu(event, entry);
    }
  };
  const nameCell = (
    <span
      className={cn(
        "min-w-0 overflow-hidden",
        !isInlineRenaming && "pointer-events-none relative z-[1]",
        tableCellPaddingClassName
      )}
    >
      <EntryNameCell
        copy={copy}
        contextLabel={contextLabel}
        entry={entry}
        iconUrlByCacheKey={iconUrlByCacheKey}
        inlineRenameValidation={inlineRenameValidation}
        isEnteringDirectory={isEnteringDirectory}
        isExpanded={expanded}
        isExpandable={expandable}
        isInlineRenaming={isInlineRenaming}
        isLoadingChildren={isLoadingChildren}
        isRenaming={isRenaming}
        treeDepth={depth}
        onEntryIconViewportLeave={onEntryIconViewportLeave}
        onEntryIconViewportEnter={onEntryIconViewportEnter}
        onCancelInlineRename={onCancelInlineRename}
        onClearInlineRenameValidation={onClearInlineRenameValidation}
        onConfirmInlineRename={onConfirmInlineRename}
        onToggleDirectoryExpanded={onToggleDirectoryExpanded}
      />
    </span>
  );
  const modifiedCell = (
    <span
      className={cn(
        "truncate text-xs text-[var(--text-secondary)]",
        !isInlineRenaming && "pointer-events-none relative z-[1]",
        tableCellPaddingClassName
      )}
    >
      {formatWorkspaceFileModifiedTime(
        resolveWorkspaceFileEntryArrangeDateMs(entry, arrangeMode),
        dateLocale
      )}
    </span>
  );
  const sizeCell = (
    <span
      className={cn(
        "truncate text-xs text-[var(--text-secondary)]",
        !isInlineRenaming && "pointer-events-none relative z-[1]",
        tableCellPaddingClassName
      )}
    >
      {entry.kind === "directory"
        ? "--"
        : formatWorkspaceFileBytes(entry.sizeBytes)}
    </span>
  );

  if (isInlineRenaming) {
    return (
      <div
        {...rowProps}
        aria-label={entry.name}
        draggable={false}
        ref={divRowRef}
      >
        {nameCell}
        {modifiedCell}
        {sizeCell}
      </div>
    );
  }

  return (
    <div {...rowProps} ref={divRowRef}>
      <button
        aria-label={entry.name}
        className="absolute inset-0 z-0"
        draggable={draggable}
        ref={buttonRowRef}
        type="button"
        onDragStart={(event: ReactDragEvent<HTMLElement>) => {
          if (!draggable) {
            event.preventDefault();
            return;
          }
          onDragStart?.(entry, event.dataTransfer);
        }}
        onPointerDown={(event) => {
          onPointerDown(entry, event);
        }}
        onClick={() => {
          onClick(entry);
        }}
      />
      {nameCell}
      {modifiedCell}
      {sizeCell}
    </div>
  );
}

function MoveDragPreview({
  iconUrlByCacheKey,
  preview,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter
}: {
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  preview: WorkspaceFileManagerMoveDragPreview;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
}): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[60] flex max-w-[280px] items-center gap-2 rounded-md border border-[var(--line-1)] bg-[var(--background-fronted)] px-3 py-2 text-sm font-normal text-[var(--text-primary)] shadow-panel"
      style={
        {
          left: preview.x,
          top: preview.y,
          transform: "translate(12px, 12px)"
        } satisfies CSSProperties
      }
    >
      <WorkspaceFileEntryIcon
        entry={preview.entry}
        frameClassName="size-7"
        iconClassName="size-6"
        iconUrlByCacheKey={iconUrlByCacheKey}
        onViewportLeave={onEntryIconViewportLeave}
        onViewportEnter={onEntryIconViewportEnter}
      />
      <span className="min-w-0 truncate">{preview.entry.name}</span>
    </div>
  );
}

interface WorkspaceFileManagerMoveDrag {
  active: boolean;
  entry: WorkspaceFileEntry;
  startX: number;
  startY: number;
}

interface WorkspaceFileManagerMoveDragPreview {
  entry: WorkspaceFileEntry;
  targetDirectoryPath: string | null;
  x: number;
  y: number;
}

interface WorkspaceFileManagerMoveDragAutoScroll {
  direction: -1 | 1;
  enteredAtMs: number;
  frameId: number | null;
  lastClientY: number;
  scrollViewport: HTMLElement;
}

function resolveWorkspaceFileManagerTableScrollViewport(
  rootElement: HTMLElement | null
): HTMLElement | null {
  return (
    rootElement?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    ) ?? null
  );
}

function resolveWorkspaceFileManagerMoveDragAutoScrollDirection(
  scrollViewport: HTMLElement | null,
  clientY: number
): -1 | 1 | null {
  if (!scrollViewport) {
    return null;
  }

  const { bottom, top } = scrollViewport.getBoundingClientRect();
  const canScrollUp = scrollViewport.scrollTop > 0;
  const canScrollDown =
    scrollViewport.scrollTop + scrollViewport.clientHeight <
    scrollViewport.scrollHeight;

  if (
    canScrollUp &&
    clientY <= top + workspaceFileManagerMoveDragAutoScrollEdgePx
  ) {
    return -1;
  }

  if (
    canScrollDown &&
    clientY >= bottom - workspaceFileManagerMoveDragAutoScrollEdgePx
  ) {
    return 1;
  }

  return null;
}

function resolveMoveDragTargetEntry(
  entries: readonly WorkspaceFileEntry[],
  movedEntry: WorkspaceFileEntry,
  x: number,
  y: number
): WorkspaceFileEntry | null {
  const targetElement = document.elementFromPoint(x, y);
  const rowElement = targetElement?.closest<HTMLElement>(
    "[data-workspace-file-entry-path]"
  );
  const targetPath = rowElement?.dataset.workspaceFileEntryPath;
  const targetEntry = targetPath
    ? entries.find((entry) => entry.path === targetPath)
    : null;
  if (!targetEntry || !canMoveEntryToDirectory(movedEntry, targetEntry)) {
    return null;
  }
  return targetEntry;
}

function canMoveEntryToDirectory(
  movedEntry: WorkspaceFileEntry,
  targetEntry: WorkspaceFileEntry
): boolean {
  return (
    movedEntry.kind !== "unknown" &&
    targetEntry.kind === "directory" &&
    movedEntry.path !== targetEntry.path &&
    !targetEntry.path.startsWith(`${movedEntry.path}/`)
  );
}

function TreeFeedbackRow({
  copy,
  depth,
  gridClassName,
  gridStyle,
  message,
  status,
  tableCellPaddingClassName
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  depth: number;
  gridClassName: string;
  gridStyle: CSSProperties;
  message?: string;
  status: "empty" | "error" | "loading";
  tableCellPaddingClassName: string;
}): ReactElement {
  const resolvedMessage =
    status === "loading"
      ? copy.t("loading")
      : status === "empty"
        ? copy.t("emptyDirectory")
        : (message ?? copy.t("unknownErrorMessage"));

  return (
    <div
      className={cn(
        "grid min-h-9 w-full items-center gap-x-6 border-b border-[var(--border-1)] text-left text-xs text-[var(--text-tertiary)]",
        gridClassName
      )}
      style={gridStyle}
    >
      <span className={tableCellPaddingClassName}>
        <span
          className="flex min-w-0 items-center gap-2"
          style={workspaceFileManagerTreeIndentStyle(depth)}
        >
          <span className="size-5 shrink-0" />
          {status === "loading" ? (
            <LoadingIcon className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 truncate">{resolvedMessage}</span>
        </span>
      </span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

function DirectoryDisclosureButton({
  copy,
  entry,
  expanded,
  isLoading,
  show,
  onToggle
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  entry: WorkspaceFileEntry;
  expanded: boolean;
  isLoading: boolean;
  show: boolean;
  onToggle: (entry: WorkspaceFileEntry, expanded: boolean) => void;
}): ReactElement {
  if (!show) {
    return <span aria-hidden="true" className="size-5 shrink-0" />;
  }

  return (
    <button
      aria-label={copy.t(
        expanded ? "collapseFolderLabel" : "expandFolderLabel"
      )}
      aria-expanded={expanded}
      className="pointer-events-auto grid size-5 shrink-0 place-items-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-transparency-block hover:text-[var(--text-primary)]"
      disabled={isLoading}
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(entry, expanded);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {isLoading ? (
        <LoadingIcon className="size-3 animate-spin" />
      ) : (
        <ArrowRightIcon
          className={cn(
            "size-3.5 transition-transform",
            expanded && "rotate-90"
          )}
        />
      )}
    </button>
  );
}

function workspaceFileManagerTreeIndentStyle(depth: number): CSSProperties {
  return {
    paddingLeft: `${Math.max(0, depth) * 20}px`
  };
}

function EntryNameCell({
  contextLabel = null,
  copy,
  entry,
  iconUrlByCacheKey,
  inlineRenameValidation = null,
  isEnteringDirectory = false,
  isExpanded = false,
  isExpandable = false,
  isInlineRenaming = false,
  isLoadingChildren = false,
  isRenaming = false,
  treeDepth = 0,
  onEntryIconViewportLeave,
  onEntryIconViewportEnter,
  onCancelInlineRename,
  onClearInlineRenameValidation,
  onConfirmInlineRename,
  onToggleDirectoryExpanded
}: {
  contextLabel?: string | null;
  copy: WorkspaceFileManagerI18nRuntime;
  entry: WorkspaceFileEntry;
  iconUrlByCacheKey?: ReadonlyMap<string, string | null>;
  inlineRenameValidation?: WorkspaceFileManagerInlineRenameValidation | null;
  isEnteringDirectory?: boolean;
  isExpanded?: boolean;
  isExpandable?: boolean;
  isInlineRenaming?: boolean;
  isLoadingChildren?: boolean;
  isRenaming?: boolean;
  treeDepth?: number;
  onEntryIconViewportLeave?: (entry: WorkspaceFileEntry) => void;
  onEntryIconViewportEnter?: (entry: WorkspaceFileEntry) => void;
  onCancelInlineRename: () => void;
  onClearInlineRenameValidation: () => void;
  onConfirmInlineRename: (newName: string) => Promise<boolean>;
  onToggleDirectoryExpanded: (
    entry: WorkspaceFileEntry,
    expanded: boolean
  ) => void;
}): ReactElement {
  const nameParts = splitWorkspaceFileName(entry.name);
  const hasFileExtension =
    nameParts.end.length > 0 && nameParts.end.startsWith(".");
  const [name, setName] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (!isInlineRenaming) {
      return;
    }
    setName(entry.name);
    skipBlurRef.current = false;
  }, [entry.name, entry.path, isInlineRenaming]);

  useLayoutEffect(() => {
    if (!isInlineRenaming) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (hasFileExtension) {
      input.setSelectionRange(0, nameParts.start.length);
    } else {
      input.select();
    }
  }, [hasFileExtension, isInlineRenaming, nameParts.start.length]);

  const validationMessage =
    inlineRenameValidation === "required"
      ? copy.t("createNameRequired")
      : inlineRenameValidation === "invalid"
        ? copy.t("createNameInvalid")
        : null;

  const handleConfirm = useCallback(async (): Promise<void> => {
    const confirmed = await onConfirmInlineRename(name);
    if (!confirmed) {
      inputRef.current?.focus();
    }
  }, [name, onConfirmInlineRename]);

  if (isInlineRenaming) {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5"
        style={workspaceFileManagerTreeIndentStyle(treeDepth)}
      >
        <DirectoryDisclosureButton
          copy={copy}
          entry={entry}
          expanded={isExpanded}
          isLoading={isLoadingChildren}
          show={isExpandable}
          onToggle={onToggleDirectoryExpanded}
        />
        <WorkspaceFileEntryIcon
          entry={entry}
          frameClassName="size-7"
          iconClassName="size-6"
          iconUrlByCacheKey={iconUrlByCacheKey}
          onViewportLeave={onEntryIconViewportLeave}
          onViewportEnter={onEntryIconViewportEnter}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <input
            aria-invalid={inlineRenameValidation !== null}
            aria-label={copy.t("renameLabel")}
            className={cn(
              "min-w-0 max-w-full rounded-md border border-transparent bg-[var(--transparency-block)] px-1.5 py-0.5 text-sm text-[var(--text-primary)] outline-none transition-colors duration-200 selection:bg-[var(--transparency-active)] selection:text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:border-transparent focus-visible:bg-[var(--transparency-hover)] disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)] disabled:opacity-100",
              inlineRenameValidation !== null && "border-[var(--state-danger)]"
            )}
            disabled={isRenaming}
            ref={inputRef}
            value={name}
            onBlur={() => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false;
                return;
              }
              void handleConfirm();
            }}
            onChange={(event) => {
              setName(event.currentTarget.value);
              onClearInlineRenameValidation();
            }}
            onFocus={(event) => {
              if (hasFileExtension) {
                event.currentTarget.setSelectionRange(
                  0,
                  nameParts.start.length
                );
              } else {
                event.currentTarget.select();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleConfirm();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                skipBlurRef.current = true;
                onCancelInlineRename();
              }
            }}
          />
          {validationMessage ? (
            <span className="text-xs text-[var(--state-danger)]">
              {validationMessage}
            </span>
          ) : null}
        </span>
      </span>
    );
  }

  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      style={workspaceFileManagerTreeIndentStyle(treeDepth)}
    >
      <DirectoryDisclosureButton
        copy={copy}
        entry={entry}
        expanded={isExpanded}
        isLoading={isLoadingChildren}
        show={isExpandable}
        onToggle={onToggleDirectoryExpanded}
      />
      <WorkspaceFileEntryIcon
        entry={entry}
        frameClassName="size-7"
        iconClassName="size-6"
        iconUrlByCacheKey={iconUrlByCacheKey}
        isEnteringDirectory={isEnteringDirectory}
        onViewportLeave={onEntryIconViewportLeave}
        onViewportEnter={onEntryIconViewportEnter}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 max-w-full overflow-hidden whitespace-nowrap text-sm">
          <span className="min-w-0 overflow-hidden text-ellipsis">
            {nameParts.start}
          </span>
          {nameParts.end ? (
            <span className="flex-none overflow-hidden text-ellipsis">
              {nameParts.end}
            </span>
          ) : null}
        </span>
        {contextLabel ? (
          <span className="block max-w-full truncate text-[11px] leading-3 text-[var(--text-tertiary)]">
            {contextLabel}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function EntryIcon({
  className = "size-4",
  visualKind
}: {
  className?: string;
  visualKind: ReturnType<typeof resolveWorkspaceFileVisualKind>;
}): ReactElement {
  switch (visualKind) {
    case "directory":
      return <WorkspaceFolderFallbackIcon className={className} />;
    case "image":
      return <WorkspaceImageFallbackIcon className={className} />;
    case "video":
      return <VideoFileIcon className={className} />;
    case "markdown":
    case "document":
      return <FileTextIcon className={className} />;
    case "code":
      return <FileCodeIcon className={className} />;
    case "binary":
      return <FileTextIcon className={className} />;
    default:
      return <FileTextIcon className={className} />;
  }
}

function PreviewPane({
  copy,
  dateLocale,
  entry,
  previewState
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  dateLocale?: TuttiDateLocale;
  entry: WorkspaceFileEntry | null;
  previewState: WorkspaceFilePreviewState;
}): ReactElement {
  if (!entry || previewState.status === "empty") {
    return (
      <div className="grid h-full min-h-[180px] place-items-center overflow-hidden p-8 text-center text-sm leading-5 text-[var(--text-tertiary)]">
        <span className="max-w-[24ch] [overflow-wrap:anywhere]">
          {copy.t("previewEmptyLabel")}
        </span>
      </div>
    );
  }

  return (
    <>
      <PreviewSurface copy={copy} previewState={previewState} />
      <div className="flex min-w-0 flex-col gap-[14px]">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <strong className="min-w-0 truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {entry.name}
          </strong>
          <p className="min-w-0 truncate text-xs text-[var(--text-secondary)]">
            {entry.path}
          </p>
        </div>
        <dl className="border-t border-[var(--border-1)]">
          <PreviewDetail
            label={copy.t("modifiedLabel")}
            value={formatWorkspaceFileModifiedTime(entry.mtimeMs, dateLocale)}
          />
          <PreviewDetail
            label={copy.t("sizeLabel")}
            value={
              entry.kind === "directory"
                ? "--"
                : formatWorkspaceFileBytes(entry.sizeBytes)
            }
          />
        </dl>
      </div>
    </>
  );
}

function PreviewSurface({
  copy,
  previewState
}: {
  copy: WorkspaceFileManagerI18nRuntime;
  previewState: WorkspaceFilePreviewState;
}): ReactElement {
  return (
    <SharedWorkspaceFilePreviewSurface<
      WorkspaceFileActivationTarget | WorkspaceFileEntry
    >
      directoryMessage={copy.t("previewDirectoryLabel")}
      emptyMessage={copy.t("previewEmptyLabel")}
      imageAlt={(entry) => entry.name}
      loadingIndicator={
        <span className="mx-auto grid size-11 place-items-center rounded-lg bg-[var(--transparency-block)]">
          <LoadingIcon className="size-4 animate-spin" />
        </span>
      }
      loadingMessage={copy.t("previewLoadingLabel")}
      renderIcon={(entry) => (
        <EntryIcon
          className="mx-auto size-7"
          visualKind={resolveWorkspaceFilePreviewIconKind(entry)}
        />
      )}
      state={previewState}
      variant="detail"
    />
  );
}

function resolveWorkspaceFilePreviewIconKind(
  entry: WorkspaceFileActivationTarget | WorkspaceFileEntry
): ReturnType<typeof resolveWorkspaceFileVisualKind> {
  if ("kind" in entry) {
    return resolveWorkspaceFileVisualKind(entry);
  }
  return entry.previewKind === "image"
    ? "image"
    : entry.previewKind === "video"
      ? "video"
      : "document";
}

function PreviewDetail({
  label,
  value
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div
      className="@max-[600px]/workspace-file-manager:grid-cols-1 @max-[600px]/workspace-file-manager:gap-0.5 grid gap-2.5 border-b border-[var(--border-1)] py-2.5 text-xs"
      style={workspaceFileManagerPreviewDetailGridStyle}
    >
      <dt className="truncate text-[var(--text-secondary)]">{label}</dt>
      <dd className="@max-[600px]/workspace-file-manager:text-left truncate text-right text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function FeedbackState({ message }: { message: string }): ReactElement {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-[var(--text-tertiary)]">
      <span className="max-w-[34ch] [overflow-wrap:anywhere]">{message}</span>
    </div>
  );
}
