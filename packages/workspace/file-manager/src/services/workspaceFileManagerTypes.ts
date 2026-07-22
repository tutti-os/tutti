import type {
  WorkspaceFileManagerHostFallbackAction,
  WorkspaceFileManagerHostImportConflict
} from "./workspaceFileManagerHostTypes.ts";
import type {
  WorkspaceFilePreviewActivationTarget,
  WorkspaceFilePreviewKind as SharedWorkspaceFilePreviewKind
} from "@tutti-os/workspace-file-preview";

export const workspaceFileManagerLogicalRoot = "/" as const;

export type WorkspaceFileEntryKind = "file" | "directory" | "unknown";
export type WorkspaceFileSearchMatchTarget = "basename" | "path";
export type WorkspaceFileImportConflictKind = "replaceable" | "type_mismatch";
export type WorkspaceFilePreviewKind = SharedWorkspaceFilePreviewKind;
export type WorkspaceFileLocationKind = "directory" | "external" | "recent";
export type WorkspaceFileManagerFileDefaultOpener =
  | "appBrowser"
  | "defaultBrowser"
  | "fileViewer"
  | "system";
export const workspaceFileManagerPersistedStateSchemaVersion = 3 as const;
export const workspaceFileManagerPreviousPersistedStateSchemaVersion =
  2 as const;

export interface WorkspaceFileEntry {
  hasChildren: boolean;
  kind: WorkspaceFileEntryKind;
  createdTimeMs?: number | null;
  lastOpenedMs?: number | null;
  mtimeMs: number | null;
  name: string;
  path: string;
  sizeBytes: number | null;
}

export interface WorkspaceFileActivationTarget extends WorkspaceFilePreviewActivationTarget {
  mtimeMs: number | null;
  sizeBytes: number | null;
}

export type WorkspaceFilePreviewState =
  | { status: "empty" }
  | { entry: WorkspaceFileEntry; status: "directory" }
  | { entry: WorkspaceFileActivationTarget; status: "loading" }
  | { content: string; entry: WorkspaceFileActivationTarget; status: "text" }
  | { entry: WorkspaceFileActivationTarget; objectUrl: string; status: "image" }
  | { entry: WorkspaceFileActivationTarget; objectUrl: string; status: "video" }
  | { entry: WorkspaceFileEntry; message: string; status: "unsupported" }
  | { entry: WorkspaceFileEntry; message: string; status: "readonly" }
  | { entry: WorkspaceFileEntry; message: string; status: "error" };

export interface WorkspaceFileDirectoryListing {
  directoryPath: string;
  entries: WorkspaceFileEntry[];
  root: string;
  workspaceID: string;
}

export interface WorkspaceFileDirectoryExpansionState {
  entries: WorkspaceFileEntry[];
  error: string | null;
  isLoading: boolean;
  loaded: boolean;
}

export interface WorkspaceFileSearchEntry {
  directoryPath: string;
  kind: WorkspaceFileEntryKind;
  matchIndices: number[];
  matchTarget: WorkspaceFileSearchMatchTarget;
  name: string;
  path: string;
  score: number;
}

export interface WorkspaceFileSearchResult {
  entries: WorkspaceFileSearchEntry[];
  root: string;
  workspaceID: string;
}

export interface WorkspaceFileLocationSection {
  id: string;
  label: string;
  locations: WorkspaceFileLocation[];
}

export type WorkspaceFileLocation =
  | WorkspaceFileDirectoryLocation
  | WorkspaceFileExternalLocation
  | WorkspaceFileRecentLocation;

export interface WorkspaceFileDirectoryLocation {
  contextLabel?: string | null;
  id: string;
  kind: "directory";
  label: string;
  path: string;
  referenceNodeId: string;
}

export interface WorkspaceFileExternalLocation {
  contextLabel?: string | null;
  externalType: string;
  iconUrl?: string | null;
  id: string;
  kind: "external";
  label: string;
  metadata: Record<string, string>;
}

export interface WorkspaceFileRecentLocation {
  contextLabel?: string | null;
  id: string;
  kind: "recent";
  label: string;
}

export interface WorkspaceFileImportConflict {
  conflictKind: WorkspaceFileImportConflictKind;
  destinationKind: WorkspaceFileEntryKind;
  destinationPath: string;
  name: string;
  sourcePath: string;
}

export type WorkspaceFileImportSummaryReason =
  | "ignored"
  | "symlink"
  | "system_metadata";

export interface WorkspaceFileImportSummaryReasonCount {
  count: number;
  reason: WorkspaceFileImportSummaryReason;
}

export interface WorkspaceFileImportSummary {
  filteredCount?: number;
  ignoredCount?: number;
  reasonBreakdown?: WorkspaceFileImportSummaryReasonCount[];
  selectedCount?: number;
}

export interface WorkspaceFileManagerPersistedState {
  currentDirectoryPath: string;
  navigationBackStack: string[];
  navigationForwardStack: string[];
  selectedLocationId: string | null;
  schemaVersion: typeof workspaceFileManagerPersistedStateSchemaVersion;
}

export interface WorkspaceFileSearchInput {
  includeKinds?: Extract<WorkspaceFileEntryKind, "file" | "directory">[];
  limit?: number;
  query: string;
  within?: string;
}

export interface WorkspaceFileOpenWithApplication {
  applicationPath: string;
  iconDataUrl?: string | null;
  name: string;
}

export interface WorkspaceFileManagerCapabilities {
  canCopy: boolean;
  canCreateDirectory: boolean;
  canCreateFile: boolean;
  canDelete: boolean;
  canExport: boolean;
  canImportFromDrop: boolean;
  canImportFromPicker: boolean;
  canMove: boolean;
  canOpenInAppBrowser: boolean;
  canOpenInDefaultBrowser: boolean;
  canOpenWith: boolean;
  canPickOtherOpenWithApplication: boolean;
  canRevealInFolder: boolean;
  canRename: boolean;
  canSearch: boolean;
}

export type WorkspaceFileManagerBusyAction =
  | "create"
  | "delete"
  | "export"
  | "import"
  | "move"
  | "rename"
  | "view";

export interface WorkspaceFileManagerCreateDialogState {
  errorMessage: string | null;
  kind: "directory" | "file";
  name: string;
}

export type WorkspaceFileManagerInlineRenameValidation = "invalid" | "required";

export interface WorkspaceFileManagerDeleteDialogState {
  entryPath: string;
}

export interface WorkspaceFileManagerContextMenuState {
  entryPath: string | null;
  x: number;
  y: number;
}

export interface WorkspaceFileManagerUnsupportedDialogState {
  actions?: WorkspaceFileManagerHostFallbackAction[] | null;
  entryPath?: string | null;
  kind: "import" | "view";
  message?: string | null;
  title?: string | null;
}

export interface WorkspaceFileManagerState {
  busyAction: WorkspaceFileManagerBusyAction | null;
  capabilities: WorkspaceFileManagerCapabilities;
  contextMenu: WorkspaceFileManagerContextMenuState | null;
  contextMenuEntryPath: string | null;
  createDialog: WorkspaceFileManagerCreateDialogState | null;
  currentDirectoryPath: string;
  deleteDialog: WorkspaceFileManagerDeleteDialogState | null;
  directoryExpansionByPath: Record<
    string,
    WorkspaceFileDirectoryExpansionState
  >;
  inlineRenameEntryPath: string | null;
  inlineRenameValidation: WorkspaceFileManagerInlineRenameValidation | null;
  dragDepth: number;
  entries: WorkspaceFileEntry[];
  error: string | null;
  expandedDirectoryPaths: Record<string, boolean>;
  isLoading: boolean;
  isMutating: boolean;
  isSearching: boolean;
  locationSections: WorkspaceFileLocationSection[];
  navigationBackStack: string[];
  navigationForwardStack: string[];
  pendingDirectoryPath: string | null;
  previewState: WorkspaceFilePreviewState;
  root: string;
  searchEntries: WorkspaceFileSearchEntry[];
  searchError: string | null;
  searchQuery: string;
  selectedLocationId: string | null;
  selectedPath: string | null;
  unsupportedDialog: WorkspaceFileManagerUnsupportedDialogState | null;
  importConflictDialog: WorkspaceFileManagerHostImportConflict | null;
  workspaceID: string;
}
