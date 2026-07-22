import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createWorkspaceFileManagerI18nRuntime } from "../../i18n/workspaceFileManagerI18n.ts";
import { createWorkspaceFileManagerStore } from "./workspaceFileManagerStore.ts";
import {
  resolveWorkspaceFileManagerContextMenuViewState,
  resolveWorkspaceFileManagerDialogsViewState,
  resolveWorkspaceFileManagerPanelsViewState,
  resolveWorkspaceFileManagerRootViewState,
  resolveWorkspaceFileManagerToolbarViewState
} from "./workspaceFileManagerViewModel.ts";
import type { WorkspaceFileManagerCapabilities } from "../workspaceFileManagerTypes.ts";

test("splits root and toolbar view state from the shared store", () => {
  const store = createStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project/src";
  store.navigationBackStack = ["/Users/demo/project"];
  store.navigationForwardStack = ["/Users/demo/project/docs"];
  store.isLoading = true;
  store.isMutating = true;
  store.isSearching = true;
  store.busyAction = "import";

  const rootView = resolveWorkspaceFileManagerRootViewState({
    state: store
  });
  const toolbarView = resolveWorkspaceFileManagerToolbarViewState({
    copy: createCopy(),
    state: store
  });

  assert.deepEqual(rootView, {
    canImportFromDrop: true,
    currentDirectoryPath: "/Users/demo/project/src",
    isBusy: true,
    locationSections: [],
    selectedLocationId: null
  });
  assert.equal(toolbarView.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(toolbarView.canGoBack, true);
  assert.equal(toolbarView.canGoForward, true);
  assert.equal(toolbarView.canSearch, true);
  assert.equal(toolbarView.isLoading, true);
  assert.equal(toolbarView.isMutating, true);
  assert.equal(toolbarView.isSearching, true);
  assert.equal(toolbarView.isImporting, true);
  assert.equal(toolbarView.searchQuery, "");
  assert.equal(toolbarView.showImportAction, true);
  assert.deepEqual(
    toolbarView.breadcrumbs.map((crumb) => crumb.path),
    ["/Users/demo/project", "/Users/demo/project/src"]
  );
});

test("disables toolbar back action at the workspace root", () => {
  const store = createStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project";
  store.navigationBackStack = ["/Users/demo/project/src"];

  const toolbarView = resolveWorkspaceFileManagerToolbarViewState({
    copy: createCopy(),
    state: store
  });

  assert.equal(toolbarView.canGoBack, false);
  assert.deepEqual(
    toolbarView.breadcrumbs.map((crumb) => crumb.path),
    ["/Users/demo/project"]
  );
});

test("splits panels and dialog view state from the shared store", () => {
  const store = createStore();
  store.root = "/Users/demo/project";
  const fileEntry = {
    hasChildren: false,
    kind: "file" as const,
    mtimeMs: null,
    name: "App.tsx",
    path: "/Users/demo/project/src/App.tsx",
    sizeBytes: 12
  };

  store.entries = [fileEntry];
  store.selectedPath = fileEntry.path;
  store.pendingDirectoryPath = "/Users/demo/project/src";
  store.previewState = {
    content: "export {};",
    entry: {
      previewKind: "code",
      mtimeMs: null,
      name: fileEntry.name,
      path: fileEntry.path,
      sizeBytes: fileEntry.sizeBytes
    },
    previewKind: "code",
    status: "text"
  };
  store.dragDepth = 1;
  store.createDialog = {
    errorMessage: null,
    kind: "file",
    name: "App.tsx"
  };
  store.deleteDialog = {
    entryPath: fileEntry.path
  };
  store.unsupportedDialog = {
    entryPath: fileEntry.path,
    kind: "view",
    message: "unsupported",
    title: "Unsupported"
  };

  const panelsView = resolveWorkspaceFileManagerPanelsViewState({
    state: store
  });
  const dialogsView = resolveWorkspaceFileManagerDialogsViewState({
    state: store
  });

  assert.equal(panelsView.selectedEntry?.path, fileEntry.path);
  assert.equal(panelsView.selectedPath, fileEntry.path);
  assert.equal(panelsView.pendingDirectoryPath, "/Users/demo/project/src");
  assert.equal(panelsView.showDropOverlay, true);
  assert.equal(dialogsView.createDialog?.name, "App.tsx");
  assert.equal(dialogsView.deleteDialogEntry?.path, fileEntry.path);
  assert.equal(dialogsView.unsupportedDialog?.entry?.path, fileEntry.path);
  assert.equal(dialogsView.isViewing, false);
});

test("panels view resolves selected search result entries", () => {
  const store = createStore();
  store.searchQuery = "notes";
  store.searchEntries = [
    {
      directoryPath: "/Users/demo/project/docs",
      kind: "file",
      matchIndices: [0, 1, 2, 3, 4],
      matchTarget: "basename",
      name: "notes.md",
      path: "/Users/demo/project/docs/notes.md",
      score: 12
    }
  ];
  store.selectedPath = "/Users/demo/project/docs/notes.md";

  const panelsView = resolveWorkspaceFileManagerPanelsViewState({
    state: store
  });

  assert.equal(panelsView.isSearchMode, true);
  assert.equal(panelsView.searchEntries.length, 1);
  assert.equal(panelsView.selectedEntry?.path, store.selectedPath);
  assert.equal(panelsView.selectedEntry?.sizeBytes, null);
});

test("search mode disables mutating file manager actions", () => {
  const searchResultPath = "/Users/demo/project/docs/notes.md";
  const store = createStore({
    canCopy: true,
    canCreateDirectory: true,
    canCreateFile: true,
    canDelete: true,
    canExport: true,
    canImportFromDrop: true,
    canImportFromPicker: true,
    canMove: true,
    canOpenInAppBrowser: true,
    canOpenInDefaultBrowser: true,
    canOpenWith: true,
    canPickOtherOpenWithApplication: true,
    canRevealInFolder: true,
    canRename: true,
    canSearch: true
  });
  store.searchQuery = "notes";
  store.searchEntries = [
    {
      directoryPath: "/Users/demo/project/docs",
      kind: "file",
      matchIndices: [0, 1, 2, 3, 4],
      matchTarget: "basename",
      name: "notes.md",
      path: searchResultPath,
      score: 12
    }
  ];
  store.contextMenu = {
    entryPath: searchResultPath,
    x: 12,
    y: 24
  };

  const rootView = resolveWorkspaceFileManagerRootViewState({
    state: store
  });
  const contextMenuView = resolveWorkspaceFileManagerContextMenuViewState({
    state: store
  });

  assert.equal(rootView.canImportFromDrop, false);
  assert.equal(contextMenuView.contextMenu?.entry?.path, searchResultPath);
  assert.equal(contextMenuView.showCreateDirectoryAction, false);
  assert.equal(contextMenuView.showCreateFileAction, false);
  assert.equal(contextMenuView.showDeleteAction, false);
  assert.equal(contextMenuView.showImportAction, false);
  assert.equal(contextMenuView.showMoveAction, false);
  assert.equal(contextMenuView.showRenameAction, false);
  assert.equal(contextMenuView.showOpenWithAction, true);
  assert.equal(contextMenuView.showRevealInFolderAction, true);
});

test("maps context-menu state without depending on unrelated fields", () => {
  const store = createStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project";
  const directoryEntry = {
    hasChildren: true,
    kind: "directory" as const,
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };

  store.entries = [directoryEntry];
  store.contextMenu = {
    entryPath: directoryEntry.path,
    x: 24,
    y: 48
  };
  store.isLoading = true;

  const contextMenuView = resolveWorkspaceFileManagerContextMenuViewState({
    state: store
  });

  assert.deepEqual(contextMenuView.contextMenu, {
    entry: directoryEntry,
    x: 24,
    y: 48
  });
  assert.equal(contextMenuView.currentDirectoryPath, "/Users/demo/project");
  assert.equal(contextMenuView.isLoading, true);
  assert.equal(contextMenuView.showImportAction, true);
});

test("hides open-with actions for directory context-menu entries", () => {
  const store = createStore(
    createCapabilities({
      canOpenInAppBrowser: true,
      canOpenInDefaultBrowser: true,
      canOpenWith: true,
      canPickOtherOpenWithApplication: true,
      canRevealInFolder: true
    })
  );
  const fileEntry = {
    hasChildren: false,
    kind: "file" as const,
    mtimeMs: null,
    name: "notes.ts",
    path: "/Users/demo/project/notes.ts",
    sizeBytes: 12
  };
  const directoryEntry = {
    hasChildren: true,
    kind: "directory" as const,
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };

  store.entries = [fileEntry, directoryEntry];
  store.contextMenu = {
    entryPath: fileEntry.path,
    x: 12,
    y: 24
  };

  const fileContextMenuView = resolveWorkspaceFileManagerContextMenuViewState({
    state: store
  });
  assert.equal(fileContextMenuView.showOpenWithAction, true);
  assert.equal(fileContextMenuView.showOpenWithOtherAction, true);

  store.contextMenu = {
    entryPath: directoryEntry.path,
    x: 12,
    y: 24
  };

  const directoryContextMenuView =
    resolveWorkspaceFileManagerContextMenuViewState({
      state: store
    });
  assert.equal(directoryContextMenuView.showOpenWithAction, false);
  assert.equal(directoryContextMenuView.showOpenWithOtherAction, false);
});

test("keeps default-browser opening available in external locations", () => {
  const store = createStore(
    createCapabilities({
      canOpenInAppBrowser: true,
      canOpenInDefaultBrowser: true
    })
  );
  const fileEntry = {
    hasChildren: false,
    kind: "file" as const,
    mtimeMs: null,
    name: "index.html",
    path: "/Users/demo/project/index.html",
    sizeBytes: 12
  };

  store.locationSections = [
    {
      id: "references",
      label: "References",
      locations: [
        {
          externalType: "workspace-reference",
          id: "reference:artifact:1",
          kind: "external",
          label: "Artifact",
          metadata: {}
        }
      ]
    }
  ];
  store.selectedLocationId = "reference:artifact:1";
  store.entries = [fileEntry];
  store.contextMenu = {
    entryPath: fileEntry.path,
    x: 12,
    y: 24
  };

  const contextMenuView = resolveWorkspaceFileManagerContextMenuViewState({
    state: store
  });

  assert.equal(contextMenuView.showOpenInAppBrowserAction, false);
  assert.equal(contextMenuView.showOpenInDefaultBrowserAction, true);
});

test("keeps each create context-menu action behind its matching capability", () => {
  const store = createStore(
    createCapabilities({
      canCreateDirectory: false,
      canCreateFile: false
    })
  );

  const withoutCreateCapabilities =
    resolveWorkspaceFileManagerContextMenuViewState({
      state: store
    });
  assert.equal(withoutCreateCapabilities.showCreateDirectoryAction, false);
  assert.equal(withoutCreateCapabilities.showCreateFileAction, false);

  store.capabilities.canCreateFile = true;
  const withFileCreateCapability =
    resolveWorkspaceFileManagerContextMenuViewState({ state: store });
  assert.equal(withFileCreateCapability.showCreateDirectoryAction, false);
  assert.equal(withFileCreateCapability.showCreateFileAction, true);

  store.capabilities.canCreateDirectory = true;
  store.capabilities.canCreateFile = false;
  const withDirectoryCreateCapability =
    resolveWorkspaceFileManagerContextMenuViewState({ state: store });
  assert.equal(withDirectoryCreateCapability.showCreateDirectoryAction, true);
  assert.equal(withDirectoryCreateCapability.showCreateFileAction, false);
});

function createCopy() {
  return createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [
        {
          "workspaceFileManager.breadcrumbRootLabel": "Workspace"
        }
      ]
    })
  );
}

function createStore(
  capabilities: WorkspaceFileManagerCapabilities = createCapabilities()
) {
  return createWorkspaceFileManagerStore({
    capabilities,
    workspaceID: "workspace-1"
  });
}

function createCapabilities(
  overrides: Partial<WorkspaceFileManagerCapabilities> = {}
): WorkspaceFileManagerCapabilities {
  return {
    canCopy: true,
    canCreateDirectory: true,
    canCreateFile: true,
    canDelete: true,
    canExport: true,
    canImportFromDrop: true,
    canImportFromPicker: true,
    canMove: true,
    canOpenInAppBrowser: false,
    canOpenInDefaultBrowser: false,
    canOpenWith: false,
    canPickOtherOpenWithApplication: false,
    canRevealInFolder: false,
    canRename: true,
    canSearch: true,
    ...overrides
  };
}
