import {
  buildWorkspaceFileBreadcrumbs,
  normalizeWorkspaceFilePath,
  resolveWorkspaceFileActivationTarget
} from "../workspaceFileManagerModel.ts";
import {
  findWorkspaceFileLocationById,
  isWorkspaceFileExternalLocation,
  isWorkspaceFileRecentLocation
} from "../workspaceFileManagerLocations.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../../i18n/workspaceFileManagerI18n.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileSearchEntry,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";
import { findWorkspaceFileEntry } from "./model/entryLookup.ts";

export interface WorkspaceFileManagerRootViewState {
  canImportFromDrop: boolean;
  currentDirectoryPath: string;
  isBusy: boolean;
  locationSections: WorkspaceFileManagerState["locationSections"];
  selectedLocationId: string | null;
}

export interface WorkspaceFileManagerToolbarViewState {
  breadcrumbs: Array<{ label: string; path: string }>;
  canSearch: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  currentDirectoryPath: string;
  isBusy: boolean;
  isLoading: boolean;
  isMutating: boolean;
  isSearching: boolean;
  searchQuery: string;
  isImporting: boolean;
  showImportAction: boolean;
}

export interface WorkspaceFileManagerPanelsViewState {
  canMove: boolean;
  contextMenuEntryPath: string | null;
  entries: readonly WorkspaceFileEntry[];
  error: string | null;
  isSearchMode: boolean;
  inlineRenameEntryPath: string | null;
  inlineRenameValidation: WorkspaceFileManagerState["inlineRenameValidation"];
  isLoading: boolean;
  isRenaming: boolean;
  isSearching: boolean;
  pendingDirectoryPath: string | null;
  previewState: WorkspaceFileManagerState["previewState"];
  searchEntries: readonly WorkspaceFileSearchEntry[];
  searchError: string | null;
  searchQuery: string;
  selectedEntry: WorkspaceFileEntry | null;
  selectedPath: string | null;
  showDropOverlay: boolean;
}

export interface WorkspaceFileManagerDialogsViewState {
  createDialog: WorkspaceFileManagerState["createDialog"];
  deleteDialogEntry: WorkspaceFileEntry | null;
  isBusy: boolean;
  isDeleting: boolean;
  isImporting: boolean;
  isRenaming: boolean;
  isViewing: boolean;
  unsupportedDialog: {
    actions?: WorkspaceFileManagerState["unsupportedDialog"] extends infer T
      ? T extends { actions?: infer A }
        ? A
        : never
      : never;
    entry?: WorkspaceFileEntry;
    kind: "import" | "view";
    message?: string | null;
    title?: string | null;
  } | null;
  importConflictDialog: WorkspaceFileManagerState["importConflictDialog"];
}

export interface WorkspaceFileManagerContextMenuViewState {
  contextMenu: {
    entry: WorkspaceFileEntry | null;
    x: number;
    y: number;
  } | null;
  currentDirectoryPath: string;
  isBusy: boolean;
  isLoading: boolean;
  isMutating: boolean;
  showCreateAction: boolean;
  showCopyAction: boolean;
  showDeleteAction: boolean;
  showExportAction: boolean;
  showImportAction: boolean;
  showMoveAction: boolean;
  showOpenInAppBrowserAction: boolean;
  showOpenInDefaultBrowserAction: boolean;
  showOpenInFileViewerAction: boolean;
  showOpenWithAction: boolean;
  showOpenWithOtherAction: boolean;
  showRevealInFolderAction: boolean;
  showRenameAction: boolean;
}

export function resolveWorkspaceFileManagerRootViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerRootViewState {
  const { state } = input;
  const isRecentLocation = isWorkspaceFileRecentLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  const isExternalLocation = isWorkspaceFileExternalLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  const isSearchMode = state.searchQuery.trim().length > 0;
  return {
    canImportFromDrop:
      state.capabilities.canImportFromDrop &&
      !isRecentLocation &&
      !isExternalLocation &&
      !isSearchMode,
    currentDirectoryPath: state.currentDirectoryPath,
    isBusy: state.busyAction !== null,
    locationSections: state.locationSections,
    selectedLocationId: state.selectedLocationId
  };
}

export function resolveWorkspaceFileManagerToolbarViewState(input: {
  copy: WorkspaceFileManagerI18nRuntime;
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerToolbarViewState {
  const { copy, state } = input;
  const currentDirectoryPath = normalizeWorkspaceFilePath(
    state.currentDirectoryPath,
    state.root
  );
  return {
    breadcrumbs: buildWorkspaceFileBreadcrumbs(
      currentDirectoryPath,
      copy.t("breadcrumbRootLabel"),
      state.root
    ),
    canSearch: state.capabilities.canSearch,
    canGoBack:
      currentDirectoryPath !== normalizeWorkspaceFilePath(state.root) &&
      state.navigationBackStack.length > 0,
    canGoForward: state.navigationForwardStack.length > 0,
    currentDirectoryPath,
    isBusy: state.busyAction !== null,
    isLoading: state.isLoading,
    isMutating: state.isMutating,
    isSearching: state.isSearching,
    searchQuery: state.searchQuery,
    isImporting: state.busyAction === "import",
    showImportAction: state.capabilities.canImportFromPicker
  };
}

export function resolveWorkspaceFileManagerPanelsViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerPanelsViewState {
  const { state } = input;
  const isRecentLocation = isWorkspaceFileRecentLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  const isExternalLocation = isWorkspaceFileExternalLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  return {
    canMove:
      state.capabilities.canMove && !isRecentLocation && !isExternalLocation,
    contextMenuEntryPath: state.contextMenuEntryPath,
    entries: state.entries,
    error: state.error,
    isSearchMode: state.searchQuery.trim().length > 0,
    inlineRenameEntryPath: state.inlineRenameEntryPath,
    inlineRenameValidation: state.inlineRenameValidation,
    isLoading: state.isLoading,
    isRenaming: state.busyAction === "rename",
    isSearching: state.isSearching,
    pendingDirectoryPath: state.pendingDirectoryPath,
    previewState: state.previewState,
    searchEntries: state.searchEntries,
    searchError: state.searchError,
    searchQuery: state.searchQuery,
    selectedEntry: findSelectedEntry(state),
    selectedPath: state.selectedPath,
    showDropOverlay:
      state.capabilities.canImportFromDrop &&
      !isExternalLocation &&
      state.dragDepth > 0 &&
      state.busyAction === null
  };
}

export function resolveWorkspaceFileManagerDialogsViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerDialogsViewState {
  const { state } = input;
  const unsupportedDialogEntry = state.unsupportedDialog?.entryPath
    ? findEntry(state, state.unsupportedDialog.entryPath)
    : null;

  return {
    createDialog: state.createDialog,
    deleteDialogEntry: state.deleteDialog
      ? findEntry(state, state.deleteDialog.entryPath)
      : null,
    isBusy: state.busyAction !== null,
    isDeleting: state.busyAction === "delete",
    isImporting: state.busyAction === "import",
    isRenaming: state.busyAction === "rename",
    isViewing: state.busyAction === "view",
    unsupportedDialog: state.unsupportedDialog
      ? {
          actions: state.unsupportedDialog.actions,
          entry: unsupportedDialogEntry ?? undefined,
          kind: state.unsupportedDialog.kind,
          message: state.unsupportedDialog.message,
          title: state.unsupportedDialog.title
        }
      : null,
    importConflictDialog: state.importConflictDialog
  };
}

export function resolveWorkspaceFileManagerContextMenuViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerContextMenuViewState {
  const { state } = input;
  const isRecentLocation = isWorkspaceFileRecentLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  const isExternalLocation = isWorkspaceFileExternalLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );
  const isSearchMode = state.searchQuery.trim().length > 0;
  const contextMenuEntry = state.contextMenu?.entryPath
    ? findEntry(state, state.contextMenu.entryPath)
    : null;
  const isContextMenuFile = contextMenuEntry?.kind === "file";

  return {
    contextMenu: state.contextMenu
      ? {
          entry: contextMenuEntry,
          x: state.contextMenu.x,
          y: state.contextMenu.y
        }
      : null,
    currentDirectoryPath: state.currentDirectoryPath,
    isBusy: state.busyAction !== null,
    isLoading: state.isLoading,
    isMutating: state.isMutating,
    showCreateAction:
      !isExternalLocation &&
      !isRecentLocation &&
      !isSearchMode &&
      (state.capabilities.canCreateDirectory ||
        state.capabilities.canCreateFile),
    showCopyAction: state.capabilities.canCopy,
    showDeleteAction:
      state.capabilities.canDelete &&
      !isExternalLocation &&
      !isRecentLocation &&
      !isSearchMode,
    showExportAction: state.capabilities.canExport && !isExternalLocation,
    showImportAction:
      state.capabilities.canImportFromPicker &&
      !isExternalLocation &&
      !isRecentLocation &&
      !isSearchMode,
    showMoveAction:
      state.capabilities.canMove &&
      !isExternalLocation &&
      !isRecentLocation &&
      !isSearchMode,
    showOpenInAppBrowserAction:
      state.capabilities.canOpenInAppBrowser && !isExternalLocation,
    showOpenInDefaultBrowserAction:
      state.capabilities.canOpenInDefaultBrowser && !isExternalLocation,
    showOpenInFileViewerAction:
      contextMenuEntry !== null &&
      isContextMenuFile &&
      resolveWorkspaceFileActivationTarget(contextMenuEntry) !== null,
    showOpenWithAction: state.capabilities.canOpenWith && isContextMenuFile,
    showOpenWithOtherAction:
      state.capabilities.canPickOtherOpenWithApplication && isContextMenuFile,
    showRevealInFolderAction:
      state.capabilities.canRevealInFolder && !isExternalLocation,
    showRenameAction:
      state.capabilities.canRename &&
      !isExternalLocation &&
      !isRecentLocation &&
      !isSearchMode
  };
}

function findSelectedEntry(
  state: WorkspaceFileManagerState
): WorkspaceFileEntry | null {
  return findWorkspaceFileEntry(state, state.selectedPath);
}

function findEntry(
  state: WorkspaceFileManagerState,
  entryPath: string
): WorkspaceFileEntry | null {
  return findWorkspaceFileEntry(state, entryPath);
}
