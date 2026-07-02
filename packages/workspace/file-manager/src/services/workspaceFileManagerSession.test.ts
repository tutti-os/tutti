import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceFileManagerI18nRuntime,
  createWorkspaceFileManagerService,
  workspaceFileManagerI18nResources
} from "./index.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerHost,
  WorkspaceFileManagerPersistedState,
  WorkspaceFileSearchResult
} from "./index.ts";

function createTestI18nRuntime() {
  return createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
}

test("stale preview reads do not overwrite a newer empty selection state", async () => {
  const deferred = createDeferred<Uint8Array>();
  const entry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const host: WorkspaceFileManagerHost = {
    async listDirectory(input) {
      return {
        directoryPath: input.path,
        entries: [entry],
        root: "/Users/demo/project",
        workspaceID: input.workspaceID
      };
    }
  };
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      ...host,
      async readPreviewFile() {
        return deferred.promise;
      }
    },
    workspaceID: "workspace-1"
  });
  session.store.root = "/Users/demo/project";

  await session.initialize();
  session.select(entry.path);
  await flushMicrotasks();
  assert.equal(previewStatus(session), "loading");

  session.select(null);
  await flushMicrotasks();
  assert.equal(previewStatus(session), "empty");

  deferred.resolve(new TextEncoder().encode("hello"));
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(previewStatus(session), "empty");

  session.dispose();
});

test("preview mode transitions follow selection changes", async () => {
  const deferred = createDeferred<Uint8Array>();
  const directoryEntry: WorkspaceFileEntry = {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };
  const textEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [directoryEntry, textEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async readPreviewFile() {
        return deferred.promise;
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();

  session.select(directoryEntry.path);
  await flushMicrotasks();
  assert.equal(previewStatus(session), "directory");

  session.select(textEntry.path);
  await flushMicrotasks();
  assert.equal(previewStatus(session), "loading");
  deferred.resolve(new TextEncoder().encode("hello"));
  await flushMicrotasks();
  assert.equal(previewStatus(session), "text");

  session.dispose();
});

test("preview state is stable across repeated selection and same i18n runtime", async () => {
  let previewReads = 0;
  const entry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const i18n = createTestI18nRuntime();
  const session = createWorkspaceFileManagerService().createSession({
    i18n,
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [entry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async readPreviewFile() {
        previewReads += 1;
        return new TextEncoder().encode("hello");
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  session.select(entry.path);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previewStatus(session), "text");
  assert.equal(previewReads, 1);

  session.select(entry.path);
  session.setI18nRuntime(i18n);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previewStatus(session), "text");
  assert.equal(previewReads, 1);

  session.dispose();
});

test("reselecting the same entry repairs an empty preview state", async () => {
  const entry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [entry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async readPreviewFile() {
        return new TextEncoder().encode("hello");
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  session.store.selectedPath = entry.path;
  await flushMicrotasks();
  session.store.previewState = { status: "empty" };
  await flushMicrotasks();

  session.select(entry.path);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previewStatus(session), "text");

  session.dispose();
});

test("preview follows selected entries inside expanded directories", async () => {
  const downloadsEntry: WorkspaceFileEntry = {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: "Downloads",
    path: "/Users/demo/Downloads",
    sizeBytes: null
  };
  const nestedEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/Downloads/notes.txt",
    sizeBytes: 5
  };
  const previewReads: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      async listDirectory(input) {
        const directoryPath = input.path || "/Users/demo";
        return {
          directoryPath,
          entries:
            directoryPath === downloadsEntry.path
              ? [nestedEntry]
              : [downloadsEntry],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async readPreviewFile(_workspaceID, path) {
        previewReads.push(path);
        return new TextEncoder().encode("hello");
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.toggleDirectoryExpanded(downloadsEntry);

  session.select(nestedEntry.path);
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(previewStatus(session), "text");
  assert.deepEqual(previewReads, [nestedEntry.path]);

  session.dispose();
});

test("openEntry enters directories and records navigation history", async () => {
  const srcEntry: WorkspaceFileEntry = {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };
  const appEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "App.tsx",
    path: "/Users/demo/project/src/App.tsx",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      async listDirectory(input) {
        const directoryPath = input.path || "/Users/demo/project";
        return {
          directoryPath,
          entries:
            directoryPath === "/Users/demo/project" ? [srcEntry] : [appEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  session.select(srcEntry.path);
  await session.openEntry(srcEntry);

  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.deepEqual(session.store.navigationBackStack, ["/Users/demo/project"]);
  assert.deepEqual(session.store.navigationForwardStack, []);
  assert.equal(session.store.selectedPath, null);
  assert.deepEqual(session.store.entries, [appEntry]);

  session.dispose();
});

test("openEntry can re-enter a directory after navigating back", async () => {
  const srcEntry: WorkspaceFileEntry = {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };
  const appEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "App.tsx",
    path: "/Users/demo/project/src/App.tsx",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    i18n: createTestI18nRuntime(),
    host: {
      async listDirectory(input) {
        const directoryPath = input.path || "/Users/demo/project";
        return {
          directoryPath,
          entries:
            directoryPath === "/Users/demo/project" ? [srcEntry] : [appEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.openEntry(srcEntry);
  await session.goBack();
  await session.openEntry(srcEntry);

  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.deepEqual(session.store.navigationBackStack, ["/Users/demo/project"]);
  assert.deepEqual(session.store.navigationForwardStack, []);
  assert.deepEqual(session.store.entries, [appEntry]);

  session.dispose();
});

test("import conflict confirm flow refreshes and clears the dialog", async () => {
  let listCalls = 0;
  let confirmCalls = 0;
  const host: WorkspaceFileManagerHost = {
    async listDirectory(input) {
      listCalls += 1;
      return {
        directoryPath: input.path,
        entries: [],
        root: "/Users/demo/project",
        workspaceID: input.workspaceID
      };
    }
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      ...host,
      async importFiles() {
        return {
          supported: true,
          importConflict: {
            conflicts: [
              {
                conflictKind: "replaceable",
                destinationKind: "file",
                destinationPath: "/Users/demo/project/conflict.txt",
                name: "conflict.txt",
                sourcePath: "/tmp/conflict.txt"
              }
            ],
            onConfirm: async () => {
              confirmCalls += 1;
              return { supported: true };
            }
          }
        };
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  assert.equal(listCalls, 1);

  await session.importFiles("/Users/demo/project");
  assert.equal(session.store.importConflictDialog?.conflicts.length, 1);
  assert.equal(listCalls, 1);

  await session.confirmImportConflict();
  assert.equal(confirmCalls, 1);
  assert.equal(session.store.importConflictDialog, null);
  assert.equal(listCalls, 2);

  session.dispose();
});

test("activation failures surface through the shared unsupported dialog state", async () => {
  const entry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [entry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async activateFile() {
        throw new Error("Cannot open file");
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.openEntry(entry);

  assert.equal(session.store.unsupportedDialog?.kind, "view");
  assert.equal(session.store.unsupportedDialog?.entryPath, entry.path);
  assert.equal(session.store.unsupportedDialog?.title, "Open failed");
  assert.equal(
    session.store.unsupportedDialog?.message,
    "Something went wrong. Please try again."
  );
  assert.equal(session.store.unsupportedDialog?.actions?.[0]?.label, "Retry");

  session.dispose();
});

test("fallback activation action failures surface through shared unsupported state", async () => {
  const entry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [entry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async activateFile() {
        return {
          actions: [
            {
              kind: "open" as const,
              onSelect: async () => {
                throw new Error("Cannot open fallback action");
              }
            }
          ],
          disposition: "fallback" as const
        };
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.openEntry(entry);

  assert.equal(session.store.unsupportedDialog?.kind, "view");
  assert.equal(
    session.store.unsupportedDialog?.title,
    "Can't preview this file"
  );
  assert.equal(
    session.store.unsupportedDialog?.message,
    "Open notes.txt in your local app instead."
  );

  const action = session.store.unsupportedDialog?.actions?.[0];
  assert.ok(action);
  await session.handleActivationFallbackAction(action);

  assert.equal(session.store.unsupportedDialog?.kind, "view");
  assert.equal(session.store.unsupportedDialog?.entryPath, entry.path);
  assert.equal(session.store.unsupportedDialog?.title, "Open failed");
  assert.equal(
    session.store.unsupportedDialog?.message,
    "Something went wrong. Please try again."
  );
  assert.equal(session.store.unsupportedDialog?.actions?.[0]?.label, "Retry");

  session.dispose();
});

test("mutations refresh the current directory after success", async () => {
  let listCalls = 0;
  const host: WorkspaceFileManagerHost = {
    async createFile() {
      return {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "new-file.txt",
        path: "/Users/demo/project/new-file.txt",
        sizeBytes: 0
      };
    },
    async listDirectory(input) {
      listCalls += 1;
      return {
        directoryPath: input.path,
        entries:
          listCalls >= 2
            ? [
                {
                  hasChildren: false,
                  kind: "file",
                  mtimeMs: null,
                  name: "new-file.txt",
                  path: "/Users/demo/project/new-file.txt",
                  sizeBytes: 0
                }
              ]
            : [],
        root: "/Users/demo/project",
        workspaceID: input.workspaceID
      };
    }
  };
  const session = createWorkspaceFileManagerService().createSession({
    host,
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.createFile("/Users/demo/project/new-file.txt");

  assert.equal(listCalls, 2);
  assert.equal(
    session.store.entries[0]?.path,
    "/Users/demo/project/new-file.txt"
  );

  session.dispose();
});

test("stale search results do not overwrite newer query results", async () => {
  const firstSearch = createDeferred<WorkspaceFileSearchResult>();
  const secondSearch = createDeferred<WorkspaceFileSearchResult>();
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async search(input) {
        return input.query === "first"
          ? firstSearch.promise
          : secondSearch.promise;
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  const firstPromise = session.search("first");
  await flushMicrotasks();
  const secondPromise = session.search("second");
  await flushMicrotasks();

  secondSearch.resolve({
    entries: [
      {
        directoryPath: "/Users/demo/project",
        kind: "file",
        matchIndices: [0],
        matchTarget: "basename",
        name: "second.txt",
        path: "/Users/demo/project/second.txt",
        score: 1
      }
    ],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await secondPromise;

  firstSearch.resolve({
    entries: [
      {
        directoryPath: "/Users/demo/project",
        kind: "file",
        matchIndices: [0],
        matchTarget: "basename",
        name: "first.txt",
        path: "/Users/demo/project/first.txt",
        score: 1
      }
    ],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await firstPromise;

  assert.equal(session.store.searchQuery, "second");
  assert.deepEqual(
    session.store.searchEntries.map((entry) => entry.path),
    ["/Users/demo/project/second.txt"]
  );
  assert.equal(session.store.isSearching, false);

  session.dispose();
});

test("entering directories clears search state and ignores stale results", async () => {
  const deferredSearch = createDeferred<WorkspaceFileSearchResult>();
  const srcEntry: WorkspaceFileEntry = {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: "src",
    path: "/Users/demo/project/src",
    sizeBytes: null
  };
  const appEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "App.tsx",
    path: "/Users/demo/project/src/App.tsx",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        const directoryPath = input.path || "/Users/demo/project";
        return {
          directoryPath,
          entries:
            directoryPath === "/Users/demo/project" ? [srcEntry] : [appEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async search() {
        return deferredSearch.promise;
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  const searchPromise = session.search("src");
  await flushMicrotasks();
  assert.equal(session.store.searchQuery, "src");
  assert.equal(session.store.isSearching, true);

  await session.openEntry(srcEntry);

  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(session.store.searchQuery, "");
  assert.deepEqual(session.store.searchEntries, []);
  assert.equal(session.store.isSearching, false);

  deferredSearch.resolve({
    entries: [
      {
        directoryPath: "/Users/demo/project",
        kind: "directory",
        matchIndices: [0],
        matchTarget: "basename",
        name: "src",
        path: "/Users/demo/project/src",
        score: 1
      }
    ],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await searchPromise;

  assert.equal(session.store.searchQuery, "");
  assert.deepEqual(session.store.searchEntries, []);
  assert.equal(session.store.isSearching, false);
  session.dispose();
});

test("location default selection initializes from the preferred directory", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "project:repo",
    locationSections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo",
            referenceNodeId: "/Users/demo/repo"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  assert.equal(session.store.selectedLocationId, "project:repo");
  await session.initialize();

  assert.deepEqual(listedPaths, ["/Users/demo/repo"]);
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/repo");
  session.dispose();
});

test("directory location restore initializes from the persisted child directory", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    locationSections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo",
            referenceNodeId: "/Users/demo/repo"
          }
        ]
      }
    ],
    persistedState: {
      currentDirectoryPath: "/Users/demo/repo/docs",
      navigationBackStack: ["/Users/demo/repo"],
      navigationForwardStack: [],
      selectedLocationId: "project:repo",
      schemaVersion: 3
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();

  assert.deepEqual(listedPaths, ["/Users/demo/repo/docs"]);
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/repo/docs");
  assert.equal(session.store.selectedLocationId, "project:repo");
  session.dispose();
});

test("v2 persisted file manager state migrates to v3 without a selected location", () => {
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: "/Users/demo/repo",
      navigationBackStack: ["/Users/demo"],
      navigationForwardStack: [],
      schemaVersion: 2
    } as unknown as WorkspaceFileManagerPersistedState,
    workspaceID: "workspace-1"
  });

  assert.deepEqual(session.getPersistedState(), {
    currentDirectoryPath: "/Users/demo/repo",
    navigationBackStack: ["/Users/demo"],
    navigationForwardStack: [],
    selectedLocationId: null,
    schemaVersion: 3
  });
  session.dispose();
});

test("selectLocation loads directory locations and falls back when locations are removed", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "project:repo",
    locationSections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo",
            referenceNodeId: "/Users/demo/repo"
          }
        ]
      },
      {
        id: "local",
        label: "Local",
        locations: [
          {
            id: "local:home",
            kind: "directory",
            label: "Home",
            path: "/Users/demo",
            referenceNodeId: "/Users/demo"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.setLocations({
    defaultLocationId: "local:home",
    sections: [
      {
        id: "local",
        label: "Local",
        locations: [
          {
            id: "local:home",
            kind: "directory",
            label: "Home",
            path: "/Users/demo",
            referenceNodeId: "/Users/demo"
          }
        ]
      }
    ]
  });

  assert.equal(session.store.selectedLocationId, "local:home");
  assert.equal(session.store.currentDirectoryPath, "/Users/demo");
  assert.deepEqual(listedPaths, ["/Users/demo/repo", "/Users/demo"]);
  session.dispose();
});

test("setLocations reloads the selected directory when its path changes", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "project:repo",
    locationSections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo",
            referenceNodeId: "/Users/demo/repo"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.setLocations({
    defaultLocationId: "project:repo",
    sections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo-moved",
            referenceNodeId: "/Users/demo/repo-moved"
          }
        ]
      }
    ]
  });

  assert.equal(session.store.selectedLocationId, "project:repo");
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/repo-moved");
  assert.deepEqual(listedPaths, ["/Users/demo/repo", "/Users/demo/repo-moved"]);
  session.dispose();
});

test("external locations select without loading directories and persist their id", async () => {
  let copyCalls = 0;
  let importCalls = 0;
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async copyEntriesToClipboard() {
        copyCalls += 1;
      },
      async importFiles() {
        importCalls += 1;
        return { supported: true };
      },
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: 1,
              name: "notes.txt",
              path: "/Users/demo/notes.txt",
              sizeBytes: 12
            }
          ],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "local:home",
    locationSections: [
      {
        id: "local",
        label: "Local",
        locations: [
          {
            id: "local:home",
            kind: "directory",
            label: "Home",
            path: "/Users/demo",
            referenceNodeId: "/Users/demo"
          }
        ]
      },
      {
        id: "reference:app-artifact",
        label: "Apps",
        locations: [
          {
            externalType: "workspace-reference",
            id: "reference:app-artifact:g:app",
            kind: "external",
            label: "Design App",
            metadata: {
              nodeId: "g:app",
              sourceId: "app-artifact"
            }
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.initialize();
  const entry = session.store.entries[0]!;
  session.select(entry.path);
  assert.equal(session.store.selectedPath, entry.path);
  await session.selectLocation("reference:app-artifact:g:app");
  await session.refresh();
  await session.copyToClipboard(entry);
  session.startInlineRename(entry);
  session.openCreateFileDialog();
  await session.importFiles("/Users/demo");

  assert.equal(
    session.store.selectedLocationId,
    "reference:app-artifact:g:app"
  );
  assert.equal(session.store.currentDirectoryPath, "/Users/demo");
  assert.equal(session.store.selectedPath, null);
  assert.deepEqual(session.store.previewState, { status: "empty" });
  assert.equal(session.store.inlineRenameEntryPath, null);
  assert.equal(session.store.createDialog, null);
  assert.deepEqual(listedPaths, ["/Users/demo"]);
  assert.equal(copyCalls, 0);
  assert.equal(importCalls, 0);
  assert.equal(
    session.getPersistedState().selectedLocationId,
    "reference:app-artifact:g:app"
  );
  session.dispose();
});

test("recent locations load recent entries, search locally, and block mutations", async () => {
  let createFileCalls = 0;
  let hostSearchCalls = 0;
  let listDirectoryCalls = 0;
  let listRecentCalls = 0;
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listDirectoryCalls += 1;
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async listRecentEntries(input) {
        listRecentCalls += 1;
        return {
          directoryPath: "/Users/demo",
          entries: [
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: null,
              name: "notes.txt",
              path: "/Users/demo/notes.txt",
              sizeBytes: 5
            },
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: null,
              name: "archive.txt",
              path: "/Users/demo/archive.txt",
              sizeBytes: 7
            }
          ],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async createFile() {
        createFileCalls += 1;
        throw new Error("create should be blocked");
      },
      async search() {
        hostSearchCalls += 1;
        return {
          entries: [],
          root: "/Users/demo",
          workspaceID: "workspace-1"
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "local:recent",
    locationSections: [
      {
        id: "local",
        label: "Local",
        locations: [
          {
            id: "local:recent",
            kind: "recent",
            label: "Recent"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.initialize();
  assert.deepEqual(
    session.store.entries.map((entry) => entry.path),
    ["/Users/demo/notes.txt", "/Users/demo/archive.txt"]
  );

  await session.search("notes");
  assert.deepEqual(
    session.store.searchEntries.map((entry) => entry.path),
    ["/Users/demo/notes.txt"]
  );

  await session.search("demo");
  assert.deepEqual(session.store.searchEntries, []);

  await session.createFile("/Users/demo/new.txt");
  const importResult = await session.importFiles("/Users/demo");
  await session.refresh();

  assert.equal(createFileCalls, 0);
  assert.equal(hostSearchCalls, 0);
  assert.equal(listDirectoryCalls, 0);
  assert.equal(listRecentCalls, 4);
  assert.equal(importResult.supported, false);
  session.dispose();
});

test("explicit directory loads leave recent read-only mode", async () => {
  let createFileCalls = 0;
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async listRecentEntries(input) {
        return {
          directoryPath: "/Users/demo",
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async createFile(input) {
        createFileCalls += 1;
        return {
          hasChildren: false,
          kind: "file",
          mtimeMs: null,
          name: "new.txt",
          path: input.path,
          sizeBytes: 0
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "local:recent",
    locationSections: [
      {
        id: "local",
        label: "Local",
        locations: [
          {
            id: "local:recent",
            kind: "recent",
            label: "Recent"
          },
          {
            id: "local:home",
            kind: "directory",
            label: "Home",
            path: "/Users/demo",
            referenceNodeId: "/Users/demo"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.applyRevealIntent({
    mode: "open-directory",
    path: "/Users/demo/project",
    requestID: "open-directory-from-recent"
  });
  await session.createFile("/Users/demo/project/new.txt");

  assert.equal(session.store.selectedLocationId, "local:home");
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project");
  assert.equal(createFileCalls, 1);
  assert.deepEqual(listedPaths, ["/Users/demo/project", "/Users/demo/project"]);
  session.dispose();
});

test("directory location search is scoped with within", async () => {
  const withinValues: Array<string | undefined> = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      },
      async search(input) {
        withinValues.push(input.within);
        return {
          entries: [],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    defaultLocationId: "project:repo",
    locationSections: [
      {
        id: "project",
        label: "Project",
        locations: [
          {
            id: "project:repo",
            kind: "directory",
            label: "Repo",
            path: "/Users/demo/repo",
            referenceNodeId: "/Users/demo/repo"
          }
        ]
      }
    ],
    workspaceID: "workspace-1"
  });

  await session.search("app");

  assert.deepEqual(withinValues, ["/Users/demo/repo"]);
  session.dispose();
});

test("host action result messages are emitted through the session callback", async () => {
  const messages: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async importFiles() {
        return {
          completedMessage: "Import complete",
          startedMessage: "Import started",
          supported: true
        };
      }
    },
    i18n: createTestI18nRuntime(),
    onHostActionMessage(message) {
      messages.push(
        `${message.actionKind}:${message.status}:${message.message}`
      );
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.importFiles("/Users/demo/project");

  assert.deepEqual(messages, ["import:completed:Import complete"]);

  session.dispose();
});

test("host action result emits started only when no terminal message is present", async () => {
  const messages: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async importFiles() {
        return {
          startedMessage: "Import queued",
          supported: true
        };
      }
    },
    i18n: createTestI18nRuntime(),
    onHostActionMessage(message) {
      messages.push(
        `${message.actionKind}:${message.status}:${message.message}`
      );
    },
    workspaceID: "workspace-1"
  });

  await session.initialize();
  await session.importFiles("/Users/demo/project");

  assert.deepEqual(messages, ["import:started:Import queued"]);

  session.dispose();
});

test("pending search results do not mutate disposed sessions", async () => {
  const deferredSearch = createDeferred<WorkspaceFileSearchResult>();
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async search() {
        return deferredSearch.promise;
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  const searchPromise = session.search("notes");
  await flushMicrotasks();
  assert.equal(session.store.isSearching, true);

  session.dispose();
  assert.equal(session.store.isSearching, false);
  deferredSearch.resolve({
    entries: [
      {
        directoryPath: "/Users/demo/project",
        kind: "file",
        matchIndices: [0],
        matchTarget: "basename",
        name: "notes.txt",
        path: "/Users/demo/project/notes.txt",
        score: 1
      }
    ],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await searchPromise;

  assert.deepEqual(session.store.searchEntries, []);
});

test("initialize is idempotent across repeated UI attachments", async () => {
  let listCalls = 0;
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listCalls += 1;
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  session.setActive(true);
  await session.initialize();
  session.setActive(false);
  session.setActive(true);
  await session.initialize();

  assert.equal(listCalls, 1);

  session.dispose();
});

test("opening the context menu does not change the selected preview target", async () => {
  const fileEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "notes.txt",
    path: "/Users/demo/project/notes.txt",
    sizeBytes: 5
  };
  const otherFileEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "readme.md",
    path: "/Users/demo/project/readme.md",
    sizeBytes: 12
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [fileEntry, otherFileEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  await session.initialize();
  session.select(fileEntry.path);
  await flushMicrotasks();
  const previewStatusBeforeContextMenu = session.store.previewState.status;
  assert.equal(session.store.selectedPath, fileEntry.path);
  assert.notEqual(previewStatusBeforeContextMenu, "empty");

  session.openContextMenu({
    entryPath: otherFileEntry.path,
    x: 24,
    y: 48
  });

  assert.equal(session.store.selectedPath, fileEntry.path);
  assert.equal(session.store.contextMenuEntryPath, otherFileEntry.path);
  assert.equal(session.store.contextMenu?.entryPath, otherFileEntry.path);
  assert.equal(
    session.store.previewState.status,
    previewStatusBeforeContextMenu
  );

  session.closeContextMenu();
  assert.equal(session.store.contextMenuEntryPath, null);

  session.dispose();
});

test("picker-only import capability does not claim drag-and-drop support", () => {
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async importFiles() {
        return { supported: true };
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  assert.equal(session.store.capabilities.canImportFromPicker, true);
  assert.equal(session.store.capabilities.canImportFromDrop, false);

  session.dispose();
});

test("persisted state restores navigation state and excludes transient selection", async () => {
  const fileEntry: WorkspaceFileEntry = {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: "spec.md",
    path: "/Users/demo/project/docs/spec.md",
    sizeBytes: 5
  };
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [fileEntry],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: "/Users/demo/project/docs",
      navigationBackStack: ["/Users/demo/project"],
      navigationForwardStack: ["/Users/demo/project/archive"],
      selectedLocationId: null,
      schemaVersion: 3,
      selectedPath: fileEntry.path
    } as WorkspaceFileManagerPersistedState & { selectedPath: string },
    workspaceID: "workspace-1"
  });

  assert.equal(session.store.selectedPath, null);
  assert.deepEqual(session.getPersistedState(), {
    currentDirectoryPath: "/Users/demo/project/docs",
    navigationBackStack: ["/Users/demo/project"],
    navigationForwardStack: ["/Users/demo/project/archive"],
    selectedLocationId: null,
    schemaVersion: 3
  });

  await session.applyRevealIntent({
    path: "/Users/demo/project/revealed.txt",
    requestID: "reveal-1"
  });
  assert.equal(
    Object.hasOwn(session.getPersistedState(), "revealIntent"),
    false
  );
  session.dispose();
});

test("applyRevealIntent opens target directories directly when requested", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        assert.equal(input.path, "/Users/demo/project/src");
        return {
          directoryPath: input.path,
          entries: [
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: null,
              name: "index.ts",
              path: "/Users/demo/project/src/index.ts",
              sizeBytes: 42
            }
          ],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: "/Users/demo/project",
      navigationBackStack: [],
      navigationForwardStack: [],
      selectedLocationId: null,
      schemaVersion: 3
    },
    workspaceID: "workspace-1"
  });

  await session.applyRevealIntent({
    mode: "open-directory",
    path: "/Users/demo/project/src",
    requestID: "open-directory-1"
  });

  assert.deepEqual(listedPaths, ["/Users/demo/project/src"]);
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(session.store.selectedPath, null);
  session.dispose();
});

test("applyRevealIntent reveals external absolute file paths", async () => {
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "/var/folders/demo/T/codex-presentations");
        assert.equal(input.includeHidden, false);
        return {
          directoryPath: input.path,
          entries: [
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: null,
              name: "slides.pptx",
              path: "/var/folders/demo/T/codex-presentations/slides.pptx",
              sizeBytes: 42
            }
          ],
          root: "/",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: "/Users/demo",
      navigationBackStack: [],
      navigationForwardStack: [],
      selectedLocationId: null,
      schemaVersion: 3
    },
    workspaceID: "workspace-1"
  });
  session.store.root = "/Users/demo";

  await session.applyRevealIntent({
    path: "/var/folders/demo/T/codex-presentations/slides.pptx",
    requestID: "external-reveal-1"
  });

  assert.equal(session.store.root, "/");
  assert.equal(
    session.store.currentDirectoryPath,
    "/var/folders/demo/T/codex-presentations"
  );
  assert.equal(
    session.store.selectedPath,
    "/var/folders/demo/T/codex-presentations/slides.pptx"
  );
  session.dispose();
});

test("initialize preserves directory state already loaded by a reveal intent", async () => {
  const listedPaths: string[] = [];
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        listedPaths.push(input.path);
        assert.equal(input.path, "/Users/demo/project/src");
        return {
          directoryPath: input.path,
          entries: [
            {
              hasChildren: false,
              kind: "file",
              mtimeMs: null,
              name: "App.tsx",
              path: "/Users/demo/project/src/App.tsx",
              sizeBytes: 42
            }
          ],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    initialDirectoryPath: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  session.store.root = "/Users/demo/project";

  await session.applyRevealIntent({
    path: "/Users/demo/project/src/App.tsx",
    requestID: "reveal-before-initialize"
  });
  await session.initialize();

  assert.deepEqual(listedPaths, ["/Users/demo/project/src"]);
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(session.store.selectedPath, "/Users/demo/project/src/App.tsx");

  session.dispose();
});

test("invalid persisted state is ignored", () => {
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: 123,
      navigationBackStack: ["/Users/demo/project/docs"],
      navigationForwardStack: [false],
      selectedLocationId: null,
      schemaVersion: 3
    } as unknown as WorkspaceFileManagerPersistedState,
    workspaceID: "workspace-1"
  });
  session.store.root = "/Users/demo/project";

  assert.deepEqual(session.getPersistedState(), {
    currentDirectoryPath: "/",
    navigationBackStack: [],
    navigationForwardStack: [],
    selectedLocationId: null,
    schemaVersion: 3
  });

  session.dispose();
});

test("legacy persisted workspace root state is ignored", () => {
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    i18n: createTestI18nRuntime(),
    persistedState: {
      currentDirectoryPath: "/workspace/docs",
      navigationBackStack: ["/workspace"],
      navigationForwardStack: ["/workspace/archive"],
      schemaVersion: 1
    } as unknown as WorkspaceFileManagerPersistedState,
    workspaceID: "workspace-1"
  });

  assert.deepEqual(session.getPersistedState(), {
    currentDirectoryPath: "/",
    navigationBackStack: [],
    navigationForwardStack: [],
    selectedLocationId: null,
    schemaVersion: 3
  });

  session.dispose();
});

test("listOpenWithApplications caches handlers by file extension", async () => {
  let loadCount = 0;
  const session = createWorkspaceFileManagerService().createSession({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      },
      async listOpenWithApplications() {
        loadCount += 1;
        return [
          {
            applicationPath: "/Applications/Visual Studio Code.app",
            iconDataUrl: null,
            name: "Visual Studio Code"
          }
        ];
      }
    },
    i18n: createTestI18nRuntime(),
    workspaceID: "workspace-1"
  });

  const entry = {
    hasChildren: false,
    kind: "file" as const,
    mtimeMs: null,
    name: "config.json",
    path: "/workspace/config.json",
    sizeBytes: 12
  };
  const otherEntry = {
    ...entry,
    name: "settings.json",
    path: "/workspace/settings.json"
  };

  await session.listOpenWithApplications(entry);
  await session.listOpenWithApplications(otherEntry);
  assert.equal(loadCount, 1);
  assert.deepEqual(session.getCachedOpenWithApplications(otherEntry), [
    {
      applicationPath: "/Applications/Visual Studio Code.app",
      iconDataUrl: null,
      name: "Visual Studio Code"
    }
  ]);

  session.dispose();
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

function previewStatus(session: {
  store: {
    previewState: {
      status: string;
    };
  };
}): string {
  return session.store.previewState.status;
}
