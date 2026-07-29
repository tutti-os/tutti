import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceFileManagerI18nRuntime,
  workspaceFileManagerI18nResources
} from "../../i18n/workspaceFileManagerI18n.ts";
import { createWorkspaceFileManagerStore } from "./workspaceFileManagerStore.ts";
import { WorkspaceFileManagerActivationController } from "./workspaceFileManagerActivationController.ts";
import { resolveWorkspaceFileActivationTarget } from "../workspaceFileManagerModel.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerCapabilities
} from "../workspaceFileManagerTypes.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";

test("openEntry loads directories through the injected loader", async () => {
  const store = createTestStore();
  const entry = createDirectoryEntry("/workspace/src");
  const calls: string[] = [];
  store.contextMenu = { entryPath: entry.path, x: 12, y: 24 };

  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost(),
    loadDirectory: async (path) => {
      calls.push(path);
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.openEntry(entry);

  assert.deepEqual(calls, ["/workspace/src"]);
  assert.equal(store.contextMenu, null);
  assert.equal(store.pendingDirectoryPath, null);
  assert.equal(store.busyAction, null);
});

test("openEntry uses configured browser opener before file viewer", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/index.html");
  const calls: string[] = [];
  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost({
      async activateFile() {
        throw new Error("file viewer should not open");
      },
      async openFileInDefaultBrowser(input) {
        calls.push(input.path);
      }
    }),
    loadDirectory: async () => {},
    resolveErrorMessage: defaultResolveErrorMessage,
    resolveFileDefaultOpener: () => "defaultBrowser",
    store
  });

  await controller.openEntry(entry);

  assert.deepEqual(calls, [entry.path]);
  assert.equal(store.busyAction, null);
  assert.equal(store.unsupportedDialog, null);
});

test("activateFile wraps fallback action failures into unsupported results", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/notes.txt");
  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost({
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
    }),
    loadDirectory: async () => {},
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const result = await controller.activateFile({
    entry,
    target: resolveWorkspaceFileActivationTarget(entry)
  });
  assert.equal(result.disposition, "fallback");
  const action = result.actions?.[0];
  assert.ok(action && action.kind === "open");

  const fallbackResult = await action.onSelect();
  assert.equal(fallbackResult?.disposition, "unsupported");
  assert.equal(fallbackResult?.title, "Open failed");
  assert.equal(fallbackResult?.message, "Cannot open fallback action");
  assert.equal(fallbackResult?.actions?.[0]?.label, "Retry");
});

test("activateFile exposes retry action after direct activation failures", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/notes.txt");
  let activateCalls = 0;
  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost({
      async activateFile() {
        activateCalls += 1;
        if (activateCalls === 1) {
          throw new Error("Transient open failure");
        }
        return { disposition: "handled" as const };
      }
    }),
    loadDirectory: async () => {},
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const result = await controller.activateFile({
    entry,
    target: resolveWorkspaceFileActivationTarget(entry)
  });
  assert.equal(result.disposition, "unsupported");
  assert.equal(result.title, "Open failed");
  assert.equal(result.message, "Transient open failure");

  const retryAction = result.actions?.[0];
  assert.ok(retryAction && retryAction.kind === "open");
  assert.equal(retryAction.label, "Retry");
  assert.deepEqual(await retryAction.onSelect(), { disposition: "handled" });
});

test("handleFallbackAction writes unsupported dialog state from wrapped fallback actions", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/notes.txt");
  store.entries = [entry];
  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost({
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
    }),
    loadDirectory: async () => {},
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const result = await controller.activateFile({
    entry,
    target: resolveWorkspaceFileActivationTarget(entry)
  });
  assert.equal(result.disposition, "fallback");
  store.unsupportedDialog = {
    actions: result.actions ?? null,
    entryPath: entry.path,
    kind: "view",
    message: result.message,
    title: result.title
  };

  const action = store.unsupportedDialog.actions?.[0];
  assert.ok(action);
  await controller.handleFallbackAction(action);

  assert.equal(store.busyAction, null);
  assert.equal(store.unsupportedDialog?.kind, "view");
  assert.equal(store.unsupportedDialog?.entryPath, entry.path);
  assert.equal(store.unsupportedDialog?.title, "Open failed");
  assert.equal(store.unsupportedDialog?.message, "Cannot open fallback action");
  assert.equal(store.unsupportedDialog?.actions?.[0]?.label, "Retry");
});

test("openEntry clears unsupported state after handled file activation", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/notes.txt");
  store.unsupportedDialog = {
    entryPath: entry.path,
    kind: "view",
    message: "old message",
    title: "old title"
  };

  const controller = new WorkspaceFileManagerActivationController({
    copy: createTestI18nRuntime,
    host: createHost({
      async activateFile() {
        return { disposition: "handled" as const };
      }
    }),
    loadDirectory: async () => {},
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.openEntry(entry);

  assert.equal(store.unsupportedDialog, null);
  assert.equal(store.busyAction, null);
});

function createTestI18nRuntime() {
  return createWorkspaceFileManagerI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceFileManagerI18nResources.en]
    })
  );
}

function createTestStore(
  capabilities: WorkspaceFileManagerCapabilities = {
    canCopy: false,
    canCreateDirectory: false,
    canCreateFile: false,
    canDelete: false,
    canMove: false,
    canOpenInAppBrowser: false,
    canOpenInDefaultBrowser: false,
    canOpenWith: false,
    canPickOtherOpenWithApplication: false,
    canRevealInFolder: false,
    canRename: false,
    canSearch: false
  }
) {
  return createWorkspaceFileManagerStore({
    capabilities,
    workspaceID: "workspace-1"
  });
}

function createHost(overrides: Partial<WorkspaceFileManagerHost> = {}) {
  return {
    async listDirectory(input) {
      return {
        directoryPath: input.path,
        entries: [],
        root: "/workspace",
        workspaceID: input.workspaceID
      };
    },
    ...overrides
  } satisfies WorkspaceFileManagerHost;
}

function createDirectoryEntry(path: string): WorkspaceFileEntry {
  return {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name: path.split("/").at(-1) ?? "directory",
    path,
    sizeBytes: null
  };
}

function createFileEntry(path: string): WorkspaceFileEntry {
  return {
    hasChildren: false,
    kind: "file",
    mtimeMs: null,
    name: path.split("/").at(-1) ?? "file",
    path,
    sizeBytes: 5
  };
}

function defaultResolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
