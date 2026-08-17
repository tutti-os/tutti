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
import { type WorkspaceFileManagerEntryDragMode } from "./WorkspaceFileManagerPanels.tsx";
import { WorkspaceFileManagerPanelsContainer } from "./WorkspaceFileManagerPanelsContainer.tsx";
import type { ResolveWorkspaceFileManagerContextMenu } from "./workspaceFileManagerContextMenuTypes.ts";
import { WorkspaceFileManagerToolbar } from "./WorkspaceFileManagerToolbar.tsx";
import type { RenderWorkspaceFileManagerToolbarTrailingActions } from "./workspaceFileManagerToolbarTypes.ts";
import type { WorkspaceFileManagerPreviewActionsConfig } from "./workspaceFileManagerPreviewActionTypes.ts";
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
import type { WorkspaceFileManagerArrangeMode } from "./workspaceFileManagerArrangeMode.ts";
import { useWorkspaceFileManagerArrangeMode } from "./useWorkspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";
import { useWorkspaceFileManagerLayoutMode } from "./useWorkspaceFileManagerLayoutMode.ts";
import { shouldTrackDirectoryExpanded } from "./workspaceFileManagerAnalytics.ts";
import {
  resolveWorkspaceFileManagerPreservedNameColumnWidth,
  workspaceFileManagerTableNameColumnSelector,
  workspaceFileManagerTableNameMinWidthProperty
} from "./workspaceFileManagerTableSizing.ts";
import { findWorkspaceFileLocationById } from "../services/workspaceFileManagerLocations.ts";
import {
  useWorkspaceFileManagerDialogsView,
  useWorkspaceFileManagerPanelsView,
  useWorkspaceFileManagerRootView,
  useWorkspaceFileManagerToolbarView
} from "./useWorkspaceFileManagerService.ts";

const workspaceFileManagerSearchDebounceMs = 180;

export type {
  RenderWorkspaceFileManagerToolbarTrailingActions,
  WorkspaceFileManagerToolbarTrailingActionsContext
} from "./workspaceFileManagerToolbarTypes.ts";
export type {
  WorkspaceFileManagerPreviewActionId,
  WorkspaceFileManagerPreviewActionsConfig
} from "./workspaceFileManagerPreviewActionTypes.ts";

export interface WorkspaceFileManagerLocationSidebarLayout {
  contentMinWidth?: number;
  defaultWidth?: number;
  maxWidth?: number;
  persistWidth?: boolean;
}

export interface WorkspaceFileManagerProps {
  className?: string;
  dateLocale?: TuttiDateLocale;
  /** Formats physical Windows paths for user-facing labels and copy actions. */
  pathDisplayPlatform?: string | null;
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
  /**
   * Declares the action row rendered at the bottom of the preview panel. Copy
   * and open opt in with a boolean and reuse the package's session commands;
   * download and share are enabled by passing a host handler. Omit the prop to
   * keep the preview panel action-free.
   */
  previewActions?: WorkspaceFileManagerPreviewActionsConfig;
  /**
   * Optional host actions rendered in the toolbar trailing cluster, after
   * Refresh and before Search. Use for product-owned primary affordances such
   * as upload; keep multi-step transfer UX outside this package.
   */
  renderToolbarTrailingActions?: RenderWorkspaceFileManagerToolbarTrailingActions;
  i18n: WorkspaceFileManagerI18nRuntime;
  locationSidebarLayout?: WorkspaceFileManagerLocationSidebarLayout;
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
  pathDisplayPlatform,
  entryDragMode,
  i18n,
  locationSidebarLayout,
  onCopyEntry,
  onDirectoryExpanded,
  onEntryDragStart,
  previewActions,
  resolveContextMenu,
  resolveEntryIconUrl,
  renderExternalLocationContent,
  renderToolbarTrailingActions,
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
  const sidebarDefaultWidth =
    locationSidebarLayout?.defaultWidth ??
    workspaceFileManagerSidebarDefaultWidth;
  const persistSidebarWidth = locationSidebarLayout?.persistWidth ?? true;
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    persistSidebarWidth
      ? readWorkspaceFileManagerSidebarWidth()
      : sidebarDefaultWidth
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
  const sidebarContentMinWidth =
    locationSidebarLayout?.contentMinWidth ??
    (showPreviewPanel
      ? workspaceFileManagerContentMinWidth
      : workspaceFileManagerContentWithoutPreviewMinWidth);
  const sidebarConfiguredMaxWidth = locationSidebarLayout?.maxWidth;
  const sidebarMaxWidth =
    containerWidth > 0
      ? resolveWorkspaceFileManagerSidebarMaxWidth(
          containerWidth,
          sidebarContentMinWidth,
          sidebarConfiguredMaxWidth
        )
      : sidebarDefaultWidth;

  const updateSidebarWidth = useCallback(
    (width: number): number => {
      const nextWidth = clampWorkspaceFileManagerSidebarWidth({
        containerWidth: rootRef.current?.getBoundingClientRect().width ?? 0,
        contentMinWidth: sidebarContentMinWidth,
        maxWidth: sidebarConfiguredMaxWidth,
        width
      });
      setSidebarWidth(nextWidth);
      return nextWidth;
    },
    [sidebarConfiguredMaxWidth, sidebarContentMinWidth]
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
          maxWidth: sidebarConfiguredMaxWidth,
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
  }, [hasLocationSidebar, sidebarConfiguredMaxWidth, sidebarContentMinWidth]);

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
      if (persistSidebarWidth) {
        writeWorkspaceFileManagerSidebarWidth(resize.currentWidth);
      }
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    [persistSidebarWidth]
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
        if (await session.copyToClipboard(entry)) {
          await onCopyEntry?.();
        }
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

  const openContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      entry: WorkspaceFileEntry | null
    ): void => {
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
    },
    [session]
  );

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
          className="nodrag @max-[600px]/workspace-file-manager:hidden relative z-[1] -ml-1 -mr-1 h-full w-2 shrink-0 cursor-col-resize touch-none outline-none before:absolute before:left-1/2 before:h-full before:w-px before:-translate-x-1/2 before:bg-[var(--border-1)] hover:before:bg-[var(--border-focus)] focus-visible:before:bg-[var(--border-focus)]"
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
              pathDisplayPlatform={pathDisplayPlatform}
              arrangeMode={arrangeMode}
              layoutMode={layoutMode}
              onArrangeModeChange={setArrangeMode}
              onDirectoryExpanded={onDirectoryExpanded}
              onLayoutModeChange={setLayoutMode}
              renderToolbarTrailingActions={renderToolbarTrailingActions}
              session={session}
            />
            <div className="@max-[600px]/workspace-file-manager:flex-col @max-[600px]/workspace-file-manager:gap-3 flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <WorkspaceFileManagerPanelsContainer
                dateLocale={dateLocale}
                pathDisplayPlatform={pathDisplayPlatform}
                entryDragMode={entryDragMode}
                arrangeMode={arrangeMode}
                i18n={i18n}
                layoutMode={layoutMode}
                onCopyEntry={onCopyEntry}
                onDirectoryExpanded={onDirectoryExpanded}
                onEntryDragStart={onEntryDragStart}
                onOpenContextMenu={openContextMenu}
                previewActions={previewActions}
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
  pathDisplayPlatform,
  layoutMode,
  onArrangeModeChange,
  onDirectoryExpanded,
  onLayoutModeChange,
  renderToolbarTrailingActions,
  session
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  i18n: WorkspaceFileManagerI18nRuntime;
  pathDisplayPlatform?: string | null;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onArrangeModeChange: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
  onDirectoryExpanded?: (path: string) => void;
  onLayoutModeChange: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
  renderToolbarTrailingActions?: RenderWorkspaceFileManagerToolbarTrailingActions;
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
      pathDisplayPlatform={pathDisplayPlatform}
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
      renderToolbarTrailingActions={renderToolbarTrailingActions}
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
