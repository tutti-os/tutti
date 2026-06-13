import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  RefObject
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@tutti-os/ui-system";
import type { TuttiDateLocale } from "@tutti-os/ui-system/date-format";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import {
  resolveRevealInFolderLabel,
  type WorkspaceFileManagerI18nRuntime
} from "../i18n/workspaceFileManagerI18n.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileOpenWithApplication
} from "../services/workspaceFileManagerTypes.ts";
import { isWorkspaceFileBrowserOpenable } from "../services/index.ts";
import {
  WorkspaceFileManagerContextMenu,
  WorkspaceFileManagerCreateDialog,
  WorkspaceFileManagerDeleteDialog,
  WorkspaceFileManagerUnsupportedDialog,
  WorkspaceFileManagerImportConflictDialog
} from "./WorkspaceFileManagerMenus.tsx";
import {
  hasFileDragPayload,
  type WorkspaceFileManagerEntryDragMode,
  WorkspaceFileManagerPanels
} from "./WorkspaceFileManagerPanels.tsx";
import { WorkspaceFileManagerToolbar } from "./WorkspaceFileManagerToolbar.tsx";
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
  useWorkspaceFileManagerContextMenuView,
  useWorkspaceFileManagerDialogsView,
  useWorkspaceFileManagerPanelsView,
  useWorkspaceFileManagerRootView,
  useWorkspaceFileManagerToolbarView
} from "./useWorkspaceFileManagerService.ts";

export interface WorkspaceFileManagerProps {
  className?: string;
  dateLocale?: TuttiDateLocale;
  entryDragMode?: WorkspaceFileManagerEntryDragMode;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  onCopyEntry?: () => Promise<void> | void;
  onCopyPath?: (path: string) => Promise<void> | void;
  onDirectoryExpanded?: (path: string) => void;
  onEntryDragStart?: (
    entry: WorkspaceFileEntry,
    dataTransfer: DataTransfer
  ) => void;
  resolveEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  hostOs?: NodeJS.Platform;
  i18n: WorkspaceFileManagerI18nRuntime;
  session: WorkspaceFileManagerSession;
  surface?: "card" | "embedded";
}

export function WorkspaceFileManager({
  className,
  dateLocale,
  entryDragMode,
  i18n,
  onCopyEntry,
  onCopyPath,
  onDirectoryExpanded,
  onEntryDragStart,
  openInAppBrowserIcon,
  resolveOpenWithApplicationIcon,
  resolveEntryIconUrl,
  hostOs = "linux",
  session,
  surface = "card"
}: WorkspaceFileManagerProps): ReactElement {
  const rootRef = useRef<HTMLElement | null>(null);
  const { arrangeMode, setArrangeMode } = useWorkspaceFileManagerArrangeMode();
  const { layoutMode, setLayoutMode } = useWorkspaceFileManagerLayoutMode();
  const rootView = useWorkspaceFileManagerRootView(session);
  const { state: panelsState, view: panelsView } =
    useWorkspaceFileManagerPanelsView(session);

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
  }, [onCopyEntry, panelsState, panelsView.selectedEntry, session]);

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
      if (
        !panelsState.capabilities.canRename ||
        panelsState.busyAction !== null ||
        panelsState.isLoading ||
        panelsState.isMutating ||
        panelsState.inlineRenameEntryPath !== null
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
  }, [panelsState, panelsView.selectedEntry, session]);

  useEffect(() => {
    function resetDropOverlay(): void {
      session.resetDragDepth();
    }

    function handleDocumentDragOver(event: DragEvent): void {
      if (isPointInsideElement(rootRef.current, event.clientX, event.clientY)) {
        return;
      }
      session.resetDragDepth();
    }

    window.addEventListener("blur", resetDropOverlay);
    window.addEventListener("dragend", resetDropOverlay);
    window.addEventListener("drop", resetDropOverlay);
    document.addEventListener("dragover", handleDocumentDragOver, true);

    return () => {
      window.removeEventListener("blur", resetDropOverlay);
      window.removeEventListener("dragend", resetDropOverlay);
      window.removeEventListener("drop", resetDropOverlay);
      document.removeEventListener("dragover", handleDocumentDragOver, true);
    };
  }, [session]);

  function openContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry | null
  ): void {
    event.preventDefault();
    event.stopPropagation();

    const rootBounds = rootRef.current?.getBoundingClientRect();
    if (!rootBounds) {
      return;
    }

    const menuWidth = 220;
    const menuHeight = 280;
    const x = clampContextMenuCoordinate(
      event.clientX - rootBounds.left,
      rootBounds.width,
      menuWidth
    );
    const y = clampContextMenuCoordinate(
      event.clientY - rootBounds.top,
      rootBounds.height,
      menuHeight
    );

    session.openContextMenu({
      entryPath: entry?.path ?? null,
      x,
      y
    });
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>): void {
    if (
      !rootView.canImportFromDrop ||
      rootView.isBusy ||
      !hasFileDragPayload(event.dataTransfer)
    ) {
      return;
    }

    event.preventDefault();
    session.incrementDragDepth();
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>): void {
    if (
      !rootView.canImportFromDrop ||
      rootView.isBusy ||
      !hasFileDragPayload(event.dataTransfer)
    ) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>): void {
    if (
      !rootView.canImportFromDrop ||
      !hasFileDragPayload(event.dataTransfer)
    ) {
      return;
    }

    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) {
      return;
    }
    session.resetDragDepth();
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>): void {
    if (
      !rootView.canImportFromDrop ||
      rootView.isBusy ||
      !hasFileDragPayload(event.dataTransfer)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    session.resetDragDepth();
    void session.importDroppedFiles(
      event.dataTransfer,
      rootView.currentDirectoryPath
    );
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
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      ref={rootRef}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspaceFileManagerToolbarContainer
          i18n={i18n}
          arrangeMode={arrangeMode}
          layoutMode={layoutMode}
          onArrangeModeChange={setArrangeMode}
          onDirectoryExpanded={onDirectoryExpanded}
          onLayoutModeChange={setLayoutMode}
          session={session}
        />
        <div
          className="@max-[600px]/workspace-file-manager:flex-col @max-[600px]/workspace-file-manager:gap-3 flex min-h-0 min-w-0 flex-1 overflow-hidden"
          style={
            {
              "--workspace-file-manager-dialog-overlay-z-index": "20"
            } as CSSProperties
          }
        >
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
          />
        </div>
      </div>
      <WorkspaceFileManagerDialogsContainer i18n={i18n} session={session} />
      <WorkspaceFileManagerContextMenuContainer
        hostOs={hostOs}
        i18n={i18n}
        onCopyEntry={onCopyEntry}
        onCopyPath={onCopyPath}
        openInAppBrowserIcon={openInAppBrowserIcon}
        resolveOpenWithApplicationIcon={resolveOpenWithApplicationIcon}
        session={session}
      />
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

  return (
    <WorkspaceFileManagerToolbar
      breadcrumbs={view.breadcrumbs}
      canGoBack={view.canGoBack}
      canGoForward={view.canGoForward}
      copy={i18n}
      currentDirectoryPath={view.currentDirectoryPath}
      isBusy={view.isBusy}
      isLoading={view.isLoading}
      isMutating={view.isMutating}
      arrangeMode={arrangeMode}
      layoutMode={layoutMode}
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
  session
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
}): ReactElement {
  const { state, view } = useWorkspaceFileManagerPanelsView(session);
  const arrangedEntries = useMemo(
    () => sortWorkspaceFileEntriesForArrangeMode(state.entries, arrangeMode),
    [arrangeMode, state.entries]
  );
  const iconUrlByCacheKey = useWorkspaceFileEntryIconUrls({
    entries: arrangedEntries,
    resolveEntryIconUrl
  });

  return (
    <WorkspaceFileManagerPanels
      arrangeMode={arrangeMode}
      canMove={view.canMove}
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
      selectedEntry={view.selectedEntry}
      selectedPath={view.selectedPath}
      showDropOverlay={view.showDropOverlay}
      state={{
        entries: arrangedEntries,
        error: state.error,
        isLoading: state.isLoading
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
      <WorkspaceFileManagerImportConflictDialog
        busy={view.isImporting}
        copy={i18n}
        dialog={view.importConflictDialog}
        onClose={() => {
          session.closeImportConflictDialog();
        }}
        onConfirm={() => {
          void session.confirmImportConflict();
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

function WorkspaceFileManagerContextMenuContainer({
  hostOs,
  i18n,
  onCopyEntry,
  onCopyPath,
  openInAppBrowserIcon,
  resolveOpenWithApplicationIcon,
  session
}: {
  hostOs: NodeJS.Platform;
  i18n: WorkspaceFileManagerI18nRuntime;
  onCopyEntry?: () => Promise<void> | void;
  onCopyPath?: (path: string) => Promise<void> | void;
  openInAppBrowserIcon?: ReactElement;
  resolveOpenWithApplicationIcon?: (
    application: WorkspaceFileOpenWithApplication
  ) => ReactElement | null;
  session: WorkspaceFileManagerSession;
}): ReactElement | null {
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const { view } = useWorkspaceFileManagerContextMenuView(session);
  const [openWithApplications, setOpenWithApplications] = useState<
    WorkspaceFileOpenWithApplication[]
  >([]);
  const [openWithLoading, setOpenWithLoading] = useState(false);

  useEffect(() => {
    const entry = view.contextMenu?.entry;
    if (!entry || !view.showOpenWithAction) {
      return;
    }

    const cachedApplications = session.getCachedOpenWithApplications(entry);
    if (cachedApplications) {
      setOpenWithApplications(cachedApplications);
      setOpenWithLoading(false);
      return;
    }

    let cancelled = false;
    setOpenWithLoading(true);
    void session
      .listOpenWithApplications(entry)
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
  }, [session, view.contextMenu?.entry?.path, view.showOpenWithAction]);

  useCloseContextMenuOnOutsideInteraction({
    contextMenuRef,
    isOpen: view.contextMenu !== null,
    session
  });

  return (
    <WorkspaceFileManagerContextMenu
      busy={view.isBusy || view.isLoading || view.isMutating}
      copy={i18n}
      contextMenu={view.contextMenu}
      contextMenuRef={contextMenuRef}
      showCopyAction={view.showCopyAction}
      showImportAction={view.showImportAction}
      showExportAction={view.showExportAction}
      showOpenInAppBrowserAction={
        view.showOpenInAppBrowserAction &&
        !!view.contextMenu?.entry &&
        isWorkspaceFileBrowserOpenable(view.contextMenu.entry)
      }
      showOpenInDefaultBrowserAction={
        view.showOpenInDefaultBrowserAction &&
        !!view.contextMenu?.entry &&
        isWorkspaceFileBrowserOpenable(view.contextMenu.entry)
      }
      showOpenWithAction={view.showOpenWithAction}
      showOpenWithOtherAction={view.showOpenWithOtherAction}
      showRevealInFolderAction={view.showRevealInFolderAction}
      showRenameAction={view.showRenameAction}
      revealInFolderLabel={resolveRevealInFolderLabel(i18n, hostOs)}
      openInAppBrowserIcon={openInAppBrowserIcon}
      openWithApplications={openWithApplications}
      openWithLoading={openWithLoading}
      resolveOpenWithApplicationIcon={resolveOpenWithApplicationIcon}
      onClose={() => {
        session.closeContextMenu();
      }}
      onCreateDirectory={() => {
        session.openCreateDirectoryDialog();
      }}
      onCreateFile={() => {
        session.openCreateFileDialog();
      }}
      onCopy={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.closeContextMenu();
        await session.copyToClipboard(entry);
        if (onCopyEntry) {
          await onCopyEntry();
        }
      }}
      onCopyPath={async () => {
        const path = view.contextMenu?.entry?.path;
        if (!path) {
          return;
        }
        session.closeContextMenu();
        if (onCopyPath) {
          await onCopyPath(path);
          return;
        }
        await navigator.clipboard.writeText(path);
      }}
      onDelete={() => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.openDeleteDialog(entry);
      }}
      onRename={() => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        session.startInlineRename(entry);
      }}
      onExport={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.exportEntry(entry);
      }}
      onOpen={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openEntry(entry);
      }}
      onOpenInAppBrowser={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileInAppBrowser(entry);
      }}
      onOpenInDefaultBrowser={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileInDefaultBrowser(entry);
      }}
      onOpenWithApplication={async (applicationPath) => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileWithApplication(entry, applicationPath);
      }}
      onOpenWithOtherApplication={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.openFileWithOtherApplication(entry);
      }}
      onRevealInFolder={async () => {
        const entry = view.contextMenu?.entry;
        if (!entry) {
          return;
        }
        await session.revealEntry(entry);
      }}
      onImport={async () => {
        session.closeContextMenu();
        await session.importFiles(
          view.contextMenu?.entry?.kind === "directory"
            ? view.contextMenu.entry.path
            : view.currentDirectoryPath
        );
      }}
    />
  );
}

function useCloseContextMenuOnOutsideInteraction(input: {
  contextMenuRef: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  session: WorkspaceFileManagerSession;
}): void {
  const { contextMenuRef, isOpen, session } = input;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
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
      session.closeContextMenu();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        session.closeContextMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenuRef, isOpen, session]);
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

function isPointInsideElement(
  element: HTMLElement | null,
  clientX: number,
  clientY: number
): boolean {
  if (!element) {
    return false;
  }

  const bounds = element.getBoundingClientRect();
  return (
    clientX >= bounds.left &&
    clientX <= bounds.right &&
    clientY >= bounds.top &&
    clientY <= bounds.bottom
  );
}
