// Must share the same valtio module instance as subscribe() in the session.
// Mixing "valtio" with "valtio/vanilla" under Vite can create two proxyStateMaps
// and crash subscribe with: Cannot read properties of undefined (reading '2').
import { proxy } from "valtio/vanilla";
import {
  workspaceFileManagerPersistedStateSchemaVersion,
  workspaceFileManagerLogicalRoot,
  workspaceFileManagerPreviousPersistedStateSchemaVersion,
  type WorkspaceFileManagerCapabilities,
  type WorkspaceFileLocationSection,
  type WorkspaceFileManagerPersistedState,
  type WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";
import { normalizeWorkspaceFilePath } from "../workspaceFileManagerModel.ts";
import { resolveWorkspaceFileLocationDefaultId } from "../workspaceFileManagerLocations.ts";

export function createWorkspaceFileManagerStore(input: {
  capabilities: WorkspaceFileManagerCapabilities;
  defaultLocationId?: string | null;
  initialDirectoryPath?: string;
  locationSections?: WorkspaceFileLocationSection[];
  persistedState?: WorkspaceFileManagerPersistedState | null;
  workspaceID: string;
}): WorkspaceFileManagerState {
  const persistedState = normalizeWorkspaceFileManagerPersistedState(
    input.persistedState
  );
  const initialDirectoryPath = normalizeWorkspaceFilePath(
    input.initialDirectoryPath
  );
  const locationSections = input.locationSections ?? [];
  const selectedLocationId = resolveWorkspaceFileLocationDefaultId({
    defaultLocationId: input.defaultLocationId,
    persistedLocationId: persistedState?.selectedLocationId,
    sections: locationSections
  });
  return proxy<WorkspaceFileManagerState>({
    busyAction: null,
    capabilities: input.capabilities,
    contextMenu: null,
    contextMenuEntryPath: null,
    createDialog: null,
    currentDirectoryPath:
      persistedState?.currentDirectoryPath ??
      initialDirectoryPath ??
      workspaceFileManagerLogicalRoot,
    deleteDialog: null,
    directoryExpansionByPath: {},
    inlineRenameEntryPath: null,
    inlineRenameValidation: null,
    entries: [],
    error: null,
    expandedDirectoryPaths: {},
    isLoading: false,
    isMutating: false,
    isSearching: false,
    locationSections,
    navigationBackStack: persistedState?.navigationBackStack ?? [],
    navigationForwardStack: persistedState?.navigationForwardStack ?? [],
    pendingDirectoryPath: null,
    previewState: { status: "empty" },
    root: workspaceFileManagerLogicalRoot,
    searchEntries: [],
    searchError: null,
    searchQuery: "",
    selectedLocationId,
    selectedPath: null,
    unsupportedDialog: null,
    workspaceID: input.workspaceID
  });
}

export function getWorkspaceFileManagerPersistedState(
  state: WorkspaceFileManagerState
): WorkspaceFileManagerPersistedState {
  return {
    currentDirectoryPath: normalizeWorkspaceFilePath(
      state.currentDirectoryPath,
      state.root
    ),
    navigationBackStack: normalizePersistedStack(
      state.navigationBackStack,
      state.root
    ),
    navigationForwardStack: normalizePersistedStack(
      state.navigationForwardStack,
      state.root
    ),
    selectedLocationId: state.selectedLocationId ?? null,
    schemaVersion: workspaceFileManagerPersistedStateSchemaVersion
  };
}

export function normalizeWorkspaceFileManagerPersistedState(
  value: unknown
): WorkspaceFileManagerPersistedState | null {
  if (
    !isPersistedStateRecord(value) ||
    typeof value.currentDirectoryPath !== "string" ||
    !isStringArray(value.navigationBackStack) ||
    !isStringArray(value.navigationForwardStack)
  ) {
    return null;
  }
  if (
    value.schemaVersion !== workspaceFileManagerPersistedStateSchemaVersion &&
    value.schemaVersion !==
      workspaceFileManagerPreviousPersistedStateSchemaVersion
  ) {
    return null;
  }
  const selectedLocationId =
    value.schemaVersion === workspaceFileManagerPersistedStateSchemaVersion
      ? readOptionalString(value.selectedLocationId)
      : null;

  return {
    currentDirectoryPath: normalizeWorkspaceFilePath(
      value.currentDirectoryPath
    ),
    navigationBackStack: normalizePersistedStack(value.navigationBackStack),
    navigationForwardStack: normalizePersistedStack(
      value.navigationForwardStack
    ),
    selectedLocationId,
    schemaVersion: workspaceFileManagerPersistedStateSchemaVersion
  };
}

function isPersistedStateRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizePersistedStack(
  values: readonly string[] | undefined,
  root?: string | null
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) =>
      typeof value === "string" ? normalizeWorkspaceFilePath(value, root) : null
    )
    .filter((value): value is string => value !== null);
}
