import {
  useCallback,
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import type { TuttiDateLocale } from "@tutti-os/ui-system/date-format";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import {
  formatWorkspaceFilePathForDisplay,
  workspaceFileSearchEntryToEntry
} from "../services/workspaceFileManagerModel.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  type WorkspaceFileManagerEntryDragMode,
  WorkspaceFileManagerPanels
} from "./WorkspaceFileManagerPanels.tsx";
import {
  sortWorkspaceFileEntriesForArrangeMode,
  type WorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";
import { useWorkspaceFileEntryIconUrls } from "./useWorkspaceFileEntryIconUrls.ts";
import { useWorkspaceFileManagerPreviewActions } from "./useWorkspaceFileManagerPreviewActions.tsx";
import {
  buildWorkspaceFileManagerVisibleTreeRows,
  collectWorkspaceFileManagerVisibleTreeEntries,
  type WorkspaceFileManagerVisibleTreeRow
} from "./workspaceFileManagerVisibleTree.ts";
import type { WorkspaceFileManagerPreviewActionsConfig } from "./workspaceFileManagerPreviewActionTypes.ts";
import { useWorkspaceFileManagerPanelsView } from "./useWorkspaceFileManagerService.ts";

export function WorkspaceFileManagerPanelsContainer({
  arrangeMode,
  dateLocale,
  pathDisplayPlatform,
  entryDragMode,
  i18n,
  layoutMode,
  onCopyEntry,
  onDirectoryExpanded,
  onEntryDragStart,
  onOpenContextMenu,
  previewActions,
  resolveEntryIconUrl,
  session,
  showPreviewPanel
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  dateLocale?: TuttiDateLocale;
  pathDisplayPlatform?: string | null;
  entryDragMode?: WorkspaceFileManagerEntryDragMode;
  i18n: WorkspaceFileManagerI18nRuntime;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onCopyEntry?: () => Promise<void> | void;
  onDirectoryExpanded?: (path: string) => void;
  onEntryDragStart?: (
    entry: WorkspaceFileEntry,
    dataTransfer: DataTransfer
  ) => void;
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    entry: WorkspaceFileEntry | null
  ) => void;
  previewActions?: WorkspaceFileManagerPreviewActionsConfig;
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
      contextByPath.set(
        entry.path,
        formatWorkspaceFilePathForDisplay(
          entry.directoryPath,
          pathDisplayPlatform
        )
      );
    }
    return contextByPath;
  }, [pathDisplayPlatform, view.searchEntries]);
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
  const panelState = useMemo(
    () => ({
      entries: displayedEntries,
      error: view.isSearchMode ? view.searchError : state.error,
      isLoading: view.isSearchMode ? view.isSearching : state.isLoading,
      isSearchMode: view.isSearchMode
    }),
    [
      displayedEntries,
      state.error,
      state.isLoading,
      view.isSearchMode,
      view.isSearching,
      view.searchError
    ]
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
  const resolvedPreviewActions = useWorkspaceFileManagerPreviewActions({
    config: previewActions,
    copy: i18n,
    entry: view.selectedEntry,
    onCopyEntry,
    session,
    state
  });
  const handleBlankContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      onOpenContextMenu(event, null);
    },
    [onOpenContextMenu]
  );
  const handleCancelInlineRename = useCallback(() => {
    session.cancelInlineRename();
  }, [session]);
  const handleClearInlineRenameValidation = useCallback(() => {
    session.clearInlineRenameValidation();
  }, [session]);
  const handleConfirmInlineRename = useCallback(
    (newName: string) => session.confirmInlineRename(newName),
    [session]
  );
  const handleMoveEntry = useCallback(
    (entry: WorkspaceFileEntry, targetDirectoryPath: string) => {
      void session.moveEntry(entry, targetDirectoryPath);
    },
    [session]
  );
  const handleOpenEntry = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (entry.kind === "directory") {
        onDirectoryExpanded?.(entry.path);
      }
      void session.openEntry(entry);
    },
    [onDirectoryExpanded, session]
  );
  const handleSelect = useCallback(
    (path: string) => {
      session.select(path);
    },
    [session]
  );
  const handleToggleDirectoryExpanded = useCallback(
    (entry: WorkspaceFileEntry, expanded: boolean) => {
      if (!expanded) {
        onDirectoryExpanded?.(entry.path);
      }
      void session.toggleDirectoryExpanded(entry);
    },
    [onDirectoryExpanded, session]
  );

  return (
    <WorkspaceFileManagerPanels
      arrangeMode={arrangeMode}
      canMove={view.isSearchMode ? false : view.canMove}
      contextMenuEntryPath={view.contextMenuEntryPath}
      copy={i18n}
      dateLocale={dateLocale}
      pathDisplayPlatform={pathDisplayPlatform}
      entryContextByPath={view.isSearchMode ? searchEntryContextByPath : null}
      entryDragMode={entryDragMode}
      iconUrlByCacheKey={iconUrlByCacheKey}
      inlineRenameEntryPath={view.inlineRenameEntryPath}
      inlineRenameValidation={view.inlineRenameValidation}
      isRenaming={view.isRenaming}
      layoutMode={layoutMode}
      pendingDirectoryPath={view.pendingDirectoryPath}
      previewActions={resolvedPreviewActions}
      previewState={view.previewState}
      selectedEntry={view.selectedEntry}
      selectedPath={view.selectedPath}
      showPreviewPanel={showPreviewPanel}
      state={panelState}
      treeRows={displayedTreeRows}
      onBlankContextMenu={handleBlankContextMenu}
      onCancelInlineRename={handleCancelInlineRename}
      onClearInlineRenameValidation={handleClearInlineRenameValidation}
      onConfirmInlineRename={handleConfirmInlineRename}
      onEntryContextMenu={onOpenContextMenu}
      onEntryDragStart={onEntryDragStart}
      onEntryIconViewportEnter={reportEntryIconViewportEnter}
      onEntryIconViewportLeave={reportEntryIconViewportLeave}
      onMoveEntry={handleMoveEntry}
      onOpenEntry={handleOpenEntry}
      onSelect={handleSelect}
      onToggleDirectoryExpanded={handleToggleDirectoryExpanded}
    />
  );
}
