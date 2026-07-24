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
  store.busyAction = "rename";

  const rootView = resolveWorkspaceFileManagerRootViewState({
    state: store
  });
  const toolbarView = resolveWorkspaceFileManagerToolbarViewState({
    copy: createCopy(),
    state: store
  });

  assert.deepEqual(rootView, {
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
  assert.equal(toolbarView.searchQuery, "");
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
});

test("avoids duplicate breadcrumb when placeholder root is / and path is /workspace", () => {
  const store = createStore();
  store.root = "/";
  store.currentDirectoryPath = "/workspace";

  const toolbarView = resolveWorkspaceFileManagerToolbarViewState({
    copy: createCopy(),
    state: store
  });
  assert.deepEqual(
    toolbarView.breadcrumbs.map((crumb) => crumb.path),
    ["/workspace"]
  );
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
