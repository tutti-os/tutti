import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { cn } from "@tutti-os/ui-system";
import type { TuttiDateLocale } from "@tutti-os/ui-system/date-format";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileLocation
} from "../services/workspaceFileManagerTypes.ts";
import { WorkspaceFileManagerContextMenuContainer } from "./WorkspaceFileManagerContextMenuContainer.tsx";
import {
  WorkspaceFileManagerCreateDialog,
  WorkspaceFileManagerDeleteDialog,
  WorkspaceFileManagerUnsupportedDialog
} from "./WorkspaceFileManagerMenus.tsx";
import {
  type WorkspaceFileManagerEntryDragMode,
  WorkspaceFileManagerPanels
} from "./WorkspaceFileManagerPanels.tsx";
import type { ResolveWorkspaceFileManagerContextMenu } from "./workspaceFileManagerContextMenuTypes.ts";
import { WorkspaceFileManagerToolbar } from "./WorkspaceFileManagerToolbar.tsx";
import { WorkspaceFileManagerSidebar } from "./WorkspaceFileManagerSidebar.tsx";
import {
  clampWorkspaceFileManagerSidebarWidth,
  readWorkspaceFileManagerSidebarWidth,
  resolveWorkspaceFileManagerSidebarMaxWidth,
  workspaceFileManagerContentMinWidth,
  workspaceFileManagerContentWithoutPreviewMinWidth,
  workspaceFileManagerPaneResizeStep,
  workspaceFileManagerSidebarDefaultWidth,
  workspaceFileManagerSidebarMinWidth,
  writeWorkspaceFileManagerSidebarWidth
} from "./workspaceFileManagerPaneSizing.ts";
import {
  sortWorkspaceFileEntriesForArrangeMode,
  type WorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";
import { useWorkspaceFileManagerArrangeMode } from "./useWorkspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";
import { useWorkspaceFileManagerLayoutMode } from "./useWorkspaceFileManagerLayoutMode.ts";
import { useWorkspaceFileEntryIconUrls } from "./useWorkspaceFileEntryIconUrls.ts";
import { shouldTrackDirectoryExpanded } from "./workspaceFileManagerAnalytics.ts";
import {
  buildWorkspaceFileManagerVisibleTreeRows,
  collectWorkspaceFileManagerVisibleTreeEntries,
  type WorkspaceFileManagerVisibleTreeRow
} from "./workspaceFileManagerVisibleTree.ts";
import {
  resolveWorkspaceFileManagerPreservedNameColumnWidth,
  workspaceFileManagerTableNameColumnSelector,
  workspaceFileManagerTableNameMinWidthProperty
} from "./workspaceFileManagerTableSizing.ts";
import { workspaceFileSearchEntryToEntry } from "../services/workspaceFileManagerModel.ts";
import { findWorkspaceFileLocationById } from "../services/workspaceFileManagerLocations.ts";
import {
  useWorkspaceFileManagerDialogsView,
  useWorkspaceFileManagerPanelsView,
  useWorkspaceFileManagerRootView,
  useWorkspaceFileManagerToolbarView
} from "./useWorkspaceFileManagerService.ts";

const workspaceFileManagerSearchDebounceMs = 180;

export interface WorkspaceFileManagerProps {
  className?: string;
  dateLocale?: TuttiDateLocale;
  entryDragMode?: WorkspaceFileManagerEntryDragMode;
  onCopyEntry?: () => Promise<void> | void;
  onDirectoryExpanded?: (path: string) => void;
  onEntryDragStart?: (
    entry: WorkspaceFileEntry,
    dataTransfer: DataTransfer
  ) => void;
  resolveContextMenu: ResolveWorkspaceFileManagerContextMenu;
  resolveEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  renderExternalLocationContent?: (
    location: Extract<WorkspaceFileLocation, { kind: "external" }>
  ) => ReactElement | null;
  i18n: WorkspaceFileManagerI18nRuntime;
  session: WorkspaceFileManagerSession;
  /**
   * When false, hide the locations sidebar even if the session has location
   * sections. Hosts with a single workspace root (for example TSH embedded
   * Files) can turn this off. Defaults to true.
   */
  showLocationSidebar?: boolean;
  showPreviewPanel?: boolean;
  surface?: "card" | "embedded";
}

export function WorkspaceFileManager({
  className,
  dateLocale,
  entryDragMode,
  i18n,
  onCopyEntry,
  onDirectoryExpanded,
  onEntryDragStart,
  resolveContextMenu,
  resolveEntryIconUrl,
  renderExternalLocationContent,
  session,
  showLocationSidebar = true,
  showPreviewPanel = true,
  surface = "card"
}: WorkspaceFileManagerProps): ReactElement {
  const rootRef = useRef<HTMLElement | null>(null);
  const sidebarResizeRef = useRef<{
    currentWidth: number;
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(
    readWorkspaceFileManagerSidebarWidth
  );
  const [containerWidth, setContainerWidth] = useState(0);
  const { arrangeMode, setArrangeMode } = useWorkspaceFileManagerArrangeMode();
  const { layoutMode, setLayoutMode } = useWorkspaceFileManagerLayoutMode();
  const rootView = useWorkspaceFileManagerRootView(session);
  const { state: panelsState, view: panelsView } =
    useWorkspaceFileManagerPanelsView(session);
  const selectedExternalLocation = useMemo(() => {
    const location = findWorkspaceFileLocationById(
      rootView.locationSections,
      rootView.selectedLocationId
    );
    return location?.kind === "external" ? location : null;
  }, [rootView.locationSections, rootView.selectedLocationId]);
  const hasLocationSidebar =
    showLocationSidebar &&
    rootView.locationSections.some((section) => section.locations.length > 0);
  const sidebarContentMinWidth = showPreviewPanel
    ? workspaceFileManagerContentMinWidth
    : workspaceFileManagerContentWithoutPreviewMinWidth;
  const sidebarMaxWidth =
    containerWidth > 0
      ? resolveWorkspaceFileManagerSidebarMaxWidth(
          containerWidth,
          sidebarContentMinWidth
        )
      : workspaceFileManagerSidebarDefaultWidth;

  const updateSidebarWidth = useCallback(
    (width: number): number => {
      const nextWidth = clampWorkspaceFileManagerSidebarWidth({
        containerWidth: rootRef.current?.getBoundingClientRect().width ?? 0,
        contentMinWidth: sidebarContentMinWidth,
        width
      });
      setSidebarWidth(nextWidth);
      return nextWidth;
    },
    [sidebarContentMinWidth]
  );

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || !hasLocationSidebar) {
      return;
    }

    const publishLayout = () => {
      const nextContainerWidth = Math.round(
        element.getBoundingClientRect().width
      );
      setContainerWidth(nextContainerWidth);
      setSidebarWidth((currentWidth) =>
        clampWorkspaceFileManagerSidebarWidth({
          containerWidth: nextContainerWidth,
          contentMinWidth: sidebarContentMinWidth,
          width: currentWidth
        })
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
  }, [hasLocationSidebar, sidebarContentMinWidth]);

  const handleSidebarResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      const root = rootRef.current;
      const nameColumn = root?.querySelector<HTMLElement>(
        workspaceFileManagerTableNameColumnSelector
      );
      if (root && nameColumn) {
        const preservedWidth =
          resolveWorkspaceFileManagerPreservedNameColumnWidth(
            nameColumn.getBoundingClientRect().width
          );
        root.style.setProperty(
          workspaceFileManagerTableNameMinWidthProperty,
          `${preservedWidth}px`
        );
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      sidebarResizeRef.current = {
        currentWidth: sidebarWidth,
        pointerId: event.pointerId,
        startWidth: sidebarWidth,
        startX: event.clientX
      };
    },
    [sidebarWidth]
  );

  const handleSidebarResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const resize = sidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      resize.currentWidth = updateSidebarWidth(
        resize.startWidth + event.clientX - resize.startX
      );
    },
    [updateSidebarWidth]
  );

  const handleSidebarResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const resize = sidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      sidebarResizeRef.current = null;
      writeWorkspaceFileManagerSidebarWidth(resize.currentWidth);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    []
  );

  const handleSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      let nextWidth: number | null = null;
      if (event.key === "Home") {
        event.preventDefault();
        nextWidth = updateSidebarWidth(workspaceFileManagerSidebarMinWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        nextWidth = updateSidebarWidth(sidebarMaxWidth);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nextWidth = updateSidebarWidth(
          sidebarWidth +
            (event.key === "ArrowLeft"
              ? -workspaceFileManagerPaneResizeStep
              : workspaceFileManagerPaneResizeStep)
        );
      }
      if (nextWidth !== null) {
        writeWorkspaceFileManagerSidebarWidth(nextWidth);
      }
    },
    [sidebarMaxWidth, sidebarWidth, updateSidebarWidth]
  );

  useEffect(() => {
    function handleCopyShortcut(event: KeyboardEvent): void {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key !== "c" ||
        event.shiftKey
      ) {
        return;
      }
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      if (!rootRef.current?.contains(event.target as Node)) {
        return;
      }
      if (selectedExternalLocation) {
        return;
      }
      if (
        !panelsState.capabilities.canCopy ||
        panelsState.busyAction !== null ||
        panelsState.isLoading ||
        panelsState.isMutating
      ) {
        return;
      }

      const entry = panelsView.selectedEntry;
      if (!entry) {
        return;
      }

      event.preventDefault();
      void (async () => {
        await session.copyToClipboard(entry);
        await onCopyEntry?.();
      })();
    }

    window.addEventListener("keydown", handleCopyShortcut);
    return () => {
      window.removeEventListener("keydown", handleCopyShortcut);
    };
  }, [
    onCopyEntry,
    panelsState,
    panelsView.selectedEntry,
    selectedExternalLocation,
    session
  ]);

  useEffect(() => {
    function handleRenameShortcut(event: KeyboardEvent): void {
      if (
        event.key !== "Enter" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      if (!rootRef.current?.contains(event.target as Node)) {
        return;
      }
      if (selectedExternalLocation) {
        return;
      }
      if (
        !panelsState.capabilities.canRename ||
        panelsState.busyAction !== null ||
        panelsState.isLoading ||
        panelsState.isMutating ||
        panelsState.inlineRenameEntryPath !== null ||
        panelsState.searchQuery.trim().length > 0
      ) {
        return;
      }

      const entry = panelsView.selectedEntry;
      if (!entry) {
        return;
      }

      event.preventDefault();
      session.startInlineRename(entry);
    }

    window.addEventListener("keydown", handleRenameShortcut);
    return () => {
      window.removeEventListener("keydown", handleRenameShortcut);
    };
  }, [
    panelsState,
    panelsView.selectedEntry,
    selectedExternalLocation,
    session
  ]);

  function openContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry | null
  ): void {
    event.preventDefault();
    event.stopPropagation();

    // Store viewport (client) coordinates. The menu renders with
    // positionMode="viewport" / fixed so overflow:hidden ancestors in host
    // shells (e.g. TSH workbench nodes) cannot clip or mis-stack it.
    const menuWidth = 220;
    const menuHeight = 280;
    const x = clampContextMenuCoordinate(
      event.clientX,
      window.innerWidth,
      menuWidth
    );
    const y = clampContextMenuCoordinate(
      event.clientY,
      window.innerHeight,
      menuHeight
    );

    session.openContextMenu({
      entryPath: entry?.path ?? null,
      x,
      y
    });
  }

  return (
    <section
      className={cn(
        "@container/workspace-file-manager relative flex h-full min-h-0 w-full overflow-hidden text-[14px] text-[var(--text-primary)]",
        surface === "card"
          ? "rounded-lg border border-[var(--border-1)] bg-[var(--background-panel)]"
          : "rounded-none border-0 bg-transparent",
        className
      )}
      data-slot="viewport-menu-boundary"
      data-workspace-file-manager=""
      ref={rootRef}
      style={
        {
          // Owned by the root so context menus (siblings of the panels pane)
          // can resolve overlay stacking instead of falling back to invalid
          // `calc(var(--undefined) - 1)`.
          "--workspace-file-manager-dialog-overlay-z-index": "20"
        } as CSSProperties
      }
    >
      {hasLocationSidebar ? (
        <WorkspaceFileManagerSidebar
          disabled={rootView.isBusy || panelsState.isLoading}
          locationSections={rootView.locationSections}
          selectedLocationId={rootView.selectedLocationId}
          width={sidebarWidth}
          onSelectLocation={(location) => {
            if (location.kind === "directory") {
              onDirectoryExpanded?.(location.path);
            }
            void session.selectLocation(location.id);
          }}
        />
      ) : null}
      {hasLocationSidebar ? (
        <div
          aria-label={i18n.t("resizeLocationsSidebar")}
          aria-orientation="vertical"
          aria-valuemax={sidebarMaxWidth}
          aria-valuemin={workspaceFileManagerSidebarMinWidth}
          aria-valuenow={sidebarWidth}
          className="nodrag @max-[600px]/workspace-file-manager:hidden relative z-[1] -ml-1 -mr-1 h-full w-2 shrink-0 cursor-col-resize touch-none outline-none before:absolute before:left-1/2 before:h-full before:w-px before:-translate-x-1/2 before:bg-transparent hover:before:bg-[var(--border-focus)] focus-visible:before:bg-[var(--border-focus)]"
          role="separator"
          tabIndex={0}
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerCancel={handleSidebarResizePointerEnd}
          onPointerDown={handleSidebarResizePointerDown}
          onPointerMove={handleSidebarResizePointerMove}
          onPointerUp={handleSidebarResizePointerEnd}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {selectedExternalLocation ? (
          (renderExternalLocationContent?.(selectedExternalLocation) ?? null)
        ) : (
          <>
            <WorkspaceFileManagerToolbarContainer
              i18n={i18n}
              arrangeMode={arrangeMode}
              layoutMode={layoutMode}
              onArrangeModeChange={setArrangeMode}
              onDirectoryExpanded={onDirectoryExpanded}
              onLayoutModeChange={setLayoutMode}
              session={session}
            />
            <div className="@max-[600px]/workspace-file-manager:flex-col @max-[600px]/workspace-file-manager:gap-3 flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <WorkspaceFileManagerPanelsContainer
                dateLocale={dateLocale}
                entryDragMode={entryDragMode}
                arrangeMode={arrangeMode}
                i18n={i18n}
                layoutMode={layoutMode}
                onDirectoryExpanded={onDirectoryExpanded}
                onEntryDragStart={onEntryDragStart}
                onOpenContextMenu={openContextMenu}
                resolveEntryIconUrl={resolveEntryIconUrl}
                session={session}
                showPreviewPanel={showPreviewPanel}
              />
            </div>
          </>
        )}
      </div>
      {!selectedExternalLocation ? (
        <>
          <WorkspaceFileManagerDialogsContainer i18n={i18n} session={session} />
          <WorkspaceFileManagerContextMenuContainer
            resolveContextMenu={resolveContextMenu}
            session={session}
          />
        </>
      ) : null}
    </section>
  );
}

function WorkspaceFileManagerToolbarContainer({
  arrangeMode,
  i18n,
  layoutMode,
  onArrangeModeChange,
  onDirectoryExpanded,
  onLayoutModeChange,
  session
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  i18n: WorkspaceFileManagerI18nRuntime;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onArrangeModeChange: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
  onDirectoryExpanded?: (path: string) => void;
  onLayoutModeChange: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
  session: WorkspaceFileManagerSession;
}): ReactElement {
  const { view } = useWorkspaceFileManagerToolbarView(session, i18n);
  const [searchQuery, setSearchQuery] = useState(view.searchQuery);
  const submittedSearchQueryRef = useRef(view.searchQuery);
  const submitSearchQuery = useCallback(
    (query: string): void => {
      submittedSearchQueryRef.current = query;
      void session.search(query);
    },
    [session]
  );

  useEffect(() => {
    if (view.searchQuery === submittedSearchQueryRef.current) {
      return;
    }
    submittedSearchQueryRef.current = view.searchQuery;
    setSearchQuery(view.searchQuery);
  }, [view.searchQuery]);

  useEffect(() => {
    if (!view.canSearch || searchQuery === submittedSearchQueryRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      submitSearchQuery(searchQuery);
    }, workspaceFileManagerSearchDebounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [searchQuery, submitSearchQuery, view.canSearch]);

  const handleSearchClear = useCallback((): void => {
    setSearchQuery("");
    submitSearchQuery("");
  }, [submitSearchQuery]);

  return (
    <WorkspaceFileManagerToolbar
      breadcrumbs={view.breadcrumbs}
      canSearch={view.canSearch}
      canGoBack={view.canGoBack}
      canGoForward={view.canGoForward}
      copy={i18n}
      currentDirectoryPath={view.currentDirectoryPath}
      isBusy={view.isBusy}
      isLoading={view.isLoading}
      isMutating={view.isMutating}
      isSearching={view.isSearching}
      arrangeMode={arrangeMode}
      layoutMode={layoutMode}
      searchQuery={searchQuery}
      onArrangeModeChange={onArrangeModeChange}
      onGoBack={() => {
        void session.goBack();
      }}
      onGoForward={() => {
        void session.goForward();
      }}
      onLayoutModeChange={onLayoutModeChange}
      onLoadDirectory={(path) => {
        if (
          shouldTrackDirectoryExpanded({
            currentDirectoryPath: view.currentDirectoryPath,
            nextDirectoryPath: path
          })
        ) {
          onDirectoryExpanded?.(path);
        }
        void session.loadDirectory(path);
      }}
      onRefresh={() => {
        void session.refresh();
      }}
      onSearchClear={handleSearchClear}
      onSearchQueryChange={setSearchQuery}
    />
  );
}

function WorkspaceFileManagerPanelsContainer({
  arrangeMode,
  dateLocale,
  entryDragMode,
  i18n,
  layoutMode,
  onDirectoryExpanded,
  onEntryDragStart,
  onOpenContextMenu,
  resolveEntryIconUrl,
  session,
  showPreviewPanel
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  dateLocale?: TuttiDateLocale;
  entryDragMode?: WorkspaceFileManagerEntryDragMode;
  i18n: WorkspaceFileManagerI18nRuntime;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onDirectoryExpanded?: (path: string) => void;
  onEntryDragStart?: (
    entry: WorkspaceFileEntry,
    dataTransfer: DataTransfer
  ) => void;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry | null
  ) => void;
  resolveEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  session: WorkspaceFileManagerSession;
  showPreviewPanel: boolean;
}): ReactElement {
  const { state, view } = useWorkspaceFileManagerPanelsView(session);
  const arrangedEntries = useMemo(
    () => sortWorkspaceFileEntriesForArrangeMode(state.entries, arrangeMode),
    [arrangeMode, state.entries]
  );
  const searchEntries = useMemo(
    () => view.searchEntries.map(workspaceFileSearchEntryToEntry),
    [view.searchEntries]
  );
  const searchEntryContextByPath = useMemo(() => {
    const contextByPath = new Map<string, string>();
    for (const entry of view.searchEntries) {
      contextByPath.set(entry.path, entry.directoryPath);
    }
    return contextByPath;
  }, [view.searchEntries]);
  const treeRows = useMemo(
    () =>
      buildWorkspaceFileManagerVisibleTreeRows({
        arrangeMode,
        directoryExpansionByPath: state.directoryExpansionByPath,
        entries: arrangedEntries,
        expandedDirectoryPaths: state.expandedDirectoryPaths
      }),
    [
      arrangeMode,
      arrangedEntries,
      state.directoryExpansionByPath,
      state.expandedDirectoryPaths
    ]
  );
  const searchTreeRows = useMemo<WorkspaceFileManagerVisibleTreeRow[]>(
    () =>
      searchEntries.map((entry) => ({
        depth: 0,
        entry,
        expanded: false,
        expandable: false,
        kind: "entry",
        loadingChildren: false
      })),
    [searchEntries]
  );
  const displayedEntries = view.isSearchMode ? searchEntries : arrangedEntries;
  const displayedTreeRows = view.isSearchMode ? searchTreeRows : treeRows;
  const visibleTreeEntries = useMemo(
    () => collectWorkspaceFileManagerVisibleTreeEntries(displayedTreeRows),
    [displayedTreeRows]
  );
  const {
    iconUrlByCacheKey,
    reportEntryIconViewportEnter,
    reportEntryIconViewportLeave
  } = useWorkspaceFileEntryIconUrls({
    entries: layoutMode === "list" ? visibleTreeEntries : displayedEntries,
    includeImageThumbnails: true,
    resolveEntryIconUrl
  });

  return (
    <WorkspaceFileManagerPanels
      arrangeMode={arrangeMode}
      canMove={view.isSearchMode ? false : view.canMove}
      contextMenuEntryPath={view.contextMenuEntryPath}
      copy={i18n}
      dateLocale={dateLocale}
      entryDragMode={entryDragMode}
      iconUrlByCacheKey={iconUrlByCacheKey}
      inlineRenameEntryPath={view.inlineRenameEntryPath}
      inlineRenameValidation={view.inlineRenameValidation}
      isRenaming={view.isRenaming}
      layoutMode={layoutMode}
      pendingDirectoryPath={view.pendingDirectoryPath}
      previewState={view.previewState}
      entryContextByPath={view.isSearchMode ? searchEntryContextByPath : null}
      treeRows={displayedTreeRows}
      onEntryIconViewportEnter={reportEntryIconViewportEnter}
      onEntryIconViewportLeave={reportEntryIconViewportLeave}
      selectedEntry={view.selectedEntry}
      selectedPath={view.selectedPath}
      showPreviewPanel={showPreviewPanel}
      state={{
        entries: displayedEntries,
        error: view.isSearchMode ? view.searchError : state.error,
        isLoading: view.isSearchMode ? view.isSearching : state.isLoading,
        isSearchMode: view.isSearchMode
      }}
      onBlankContextMenu={(event) => {
        onOpenContextMenu(event, null);
      }}
      onCancelInlineRename={() => {
        session.cancelInlineRename();
      }}
      onClearInlineRenameValidation={() => {
        session.clearInlineRenameValidation();
      }}
      onConfirmInlineRename={(newName) => {
        return session.confirmInlineRename(newName);
      }}
      onEntryContextMenu={onOpenContextMenu}
      onEntryDragStart={onEntryDragStart}
      onMoveEntry={(entry, targetDirectoryPath) => {
        void session.moveEntry(entry, targetDirectoryPath);
      }}
      onOpenEntry={(entry) => {
        if (entry.kind === "directory") {
          onDirectoryExpanded?.(entry.path);
        }
        void session.openEntry(entry);
      }}
      onSelect={(path) => {
        session.select(path);
      }}
      onToggleDirectoryExpanded={(entry, expanded) => {
        if (!expanded) {
          onDirectoryExpanded?.(entry.path);
        }
        void session.toggleDirectoryExpanded(entry);
      }}
    />
  );
}

function WorkspaceFileManagerDialogsContainer({
  i18n,
  session
}: {
  i18n: WorkspaceFileManagerI18nRuntime;
  session: WorkspaceFileManagerSession;
}): ReactElement {
  const { state, view } = useWorkspaceFileManagerDialogsView(session);

  return (
    <>
      <WorkspaceFileManagerCreateDialog
        busy={view.isBusy && state.busyAction === "create"}
        copy={i18n}
        dialog={view.createDialog}
        onClose={() => {
          session.closeCreateDialog();
        }}
        onConfirm={() => {
          void session.confirmCreateDialog();
        }}
        onNameChange={(name) => {
          session.updateCreateDialogName(name);
        }}
      />
      <WorkspaceFileManagerDeleteDialog
        busy={view.isDeleting}
        copy={i18n}
        entry={view.deleteDialogEntry}
        onClose={() => {
          session.closeDeleteDialog();
        }}
        onConfirm={() => {
          void session.confirmDeleteDialog();
        }}
      />
      <WorkspaceFileManagerUnsupportedDialog
        copy={i18n}
        dialog={view.unsupportedDialog}
        isViewing={view.isViewing}
        onAction={(action) => {
          void session.handleActivationFallbackAction(action);
        }}
        onClose={() => {
          session.closeUnsupportedDialog();
        }}
      />
    </>
  );
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function clampContextMenuCoordinate(
  coordinate: number,
  boundarySize: number,
  menuSize: number
): number {
  const max = Math.max(8, boundarySize - menuSize - 8);
  return Math.min(Math.max(coordinate, 8), max);
}
