import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceFileManagerStore } from "./workspaceFileManagerStore.ts";
import { WorkspaceFileManagerMutationController } from "./workspaceFileManagerMutationController.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerCapabilities
} from "../workspaceFileManagerTypes.ts";

test("createFile normalizes the path and refreshes after success", async () => {
  const store = createTestStore();
  const createCalls: Array<{ path: string; workspaceID: string }> = [];
  let refreshCalls = 0;
  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async createFile(input) {
        createCalls.push(input);
        return createFileEntry(input.path);
      }
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.createFile("/workspace//nested///notes.txt");

  assert.deepEqual(createCalls, [
    {
      path: "/workspace/nested/notes.txt",
      workspaceID: "workspace-1"
    }
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(store.isMutating, false);
  assert.equal(store.error, null);
});

test("deleteSelected forwards entry kind and clears selection after success", async () => {
  const store = createTestStore();
  const entry = createFileEntry("/workspace/notes.txt");
  store.entries = [entry];
  store.selectedPath = entry.path;
  const deleteCalls: Array<{
    kind?: "file" | "directory" | null;
    path: string;
    workspaceID: string;
  }> = [];
  let refreshCalls = 0;

  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async deleteEntry(input) {
        deleteCalls.push(input);
      }
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.deleteSelected();

  assert.deepEqual(deleteCalls, [
    {
      kind: "file",
      path: "/workspace/notes.txt",
      workspaceID: "workspace-1"
    }
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(store.selectedPath, null);
  assert.equal(store.isMutating, false);
});

test("mutation failure sets error and skips refresh", async () => {
  const store = createTestStore();
  let refreshCalls = 0;
  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async createDirectory() {
        throw new Error("create failed");
      }
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.createDirectory("/workspace/new-folder");

  assert.equal(refreshCalls, 0);
  assert.equal(store.error, "create failed");
  assert.equal(store.isMutating, false);
});

test("handled mutation failure notifies without setting store error", async () => {
  const store = createTestStore();
  const messages: string[] = [];
  let refreshCalls = 0;
  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async createFile() {
        throw new Error("already exists");
      }
    },
    onErrorMessage(message) {
      messages.push(`${message.actionKind}:${message.message}`);
      return true;
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.createFile("/workspace/notes.txt");

  assert.equal(refreshCalls, 0);
  assert.deepEqual(messages, ["create:already exists"]);
  assert.equal(store.error, null);
  assert.equal(store.isMutating, false);
});

test("deleteSelected is a safe no-op without a selected path", async () => {
  const store = createTestStore();
  let deleteCalls = 0;
  let refreshCalls = 0;
  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async deleteEntry() {
        deleteCalls += 1;
      }
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.deleteSelected();

  assert.equal(deleteCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(store.error, null);
  assert.equal(store.isMutating, false);
});

test("moveEntry forwards the target directory and selects the moved entry", async () => {
  const store = createTestStore({
    canCopy: false,
    canCreateDirectory: false,
    canCreateFile: false,
    canDelete: false,
    canMove: true,
    canOpenInAppBrowser: false,
    canOpenInDefaultBrowser: false,
    canOpenWith: false,
    canPickOtherOpenWithApplication: false,
    canRevealInFolder: false,
    canRename: false,
    canSearch: false
  });
  const entry = createFileEntry("/workspace/src/notes.txt");
  const moveCalls: Array<{
    kind: "file" | "directory";
    path: string;
    targetDirectoryPath: string;
    workspaceID: string;
  }> = [];
  let refreshCalls = 0;
  const controller = new WorkspaceFileManagerMutationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [],
          root: "/workspace",
          workspaceID: input.workspaceID
        };
      },
      async moveEntry(input) {
        moveCalls.push(input);
        return {
          ...entry,
          path: "/workspace/docs/notes.txt"
        };
      }
    },
    refresh: async () => {
      refreshCalls += 1;
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.moveEntry(entry, "/workspace/docs");

  assert.deepEqual(moveCalls, [
    {
      kind: "file",
      path: entry.path,
      targetDirectoryPath: "/workspace/docs",
      workspaceID: "workspace-1"
    }
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(store.selectedPath, "/workspace/docs/notes.txt");
  assert.equal(store.error, null);
});

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
