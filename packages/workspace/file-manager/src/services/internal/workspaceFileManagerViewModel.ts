import {
  buildWorkspaceFileBreadcrumbs,
  normalizeWorkspaceFilePath
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
}

export interface WorkspaceFileManagerDialogsViewState {
  createDialog: WorkspaceFileManagerState["createDialog"];
  deleteDialogEntry: WorkspaceFileEntry | null;
  isBusy: boolean;
  isDeleting: boolean;
  isRenaming: boolean;
  isViewing: boolean;
  unsupportedDialog: {
    actions?: WorkspaceFileManagerState["unsupportedDialog"] extends infer T
      ? T extends { actions?: infer A }
        ? A
        : never
      : never;
    entry?: WorkspaceFileEntry;
    kind: "view";
    message?: string | null;
    title?: string | null;
  } | null;
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
}

export function resolveWorkspaceFileManagerRootViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerRootViewState {
  const { state } = input;
  return {
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
    searchQuery: state.searchQuery
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
    selectedPath: state.selectedPath
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
      : null
  };
}

export function resolveWorkspaceFileManagerContextMenuViewState(input: {
  state: WorkspaceFileManagerState;
}): WorkspaceFileManagerContextMenuViewState {
  const { state } = input;
  const contextMenuEntry = state.contextMenu?.entryPath
    ? findEntry(state, state.contextMenu.entryPath)
    : null;

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
    isMutating: state.isMutating
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
