import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceFileManagerStore } from "./workspaceFileManagerStore.ts";
import { WorkspaceFileManagerNavigationController } from "./workspaceFileManagerNavigationController.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerCapabilities
} from "../workspaceFileManagerTypes.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";

test("same-path concurrent loads share one host request and keep non-empty entries", async () => {
  const store = createTestStore();
  store.root = "/workspace";
  store.currentDirectoryPath = "/workspace";
  let calls = 0;
  const slow =
    createDeferred<
      ReturnType<WorkspaceFileManagerHost["listDirectory"]> extends Promise<
        infer T
      >
        ? T
        : never
    >();

  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory() {
        calls += 1;
        return slow.promise;
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const first = controller.loadDirectory("/workspace");
  const second = controller.loadDirectory("/workspace");
  assert.equal(calls, 1);

  slow.resolve({
    directoryPath: "/workspace",
    entries: [createFileEntry("/workspace/.tsh")],
    root: "/workspace",
    workspaceID: "workspace-1"
  });
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(store.entries[0]?.name, ".tsh");
  assert.equal(store.isLoading, false);
});

test("latest directory load wins over stale earlier requests", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project";
  const slow =
    createDeferred<
      ReturnType<WorkspaceFileManagerHost["listDirectory"]> extends Promise<
        infer T
      >
        ? T
        : never
    >();
  const fast =
    createDeferred<
      ReturnType<WorkspaceFileManagerHost["listDirectory"]> extends Promise<
        infer T
      >
        ? T
        : never
    >();

  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        if (input.path === "/Users/demo/project/slow") {
          return slow.promise;
        }
        if (input.path === "/Users/demo/project/fast") {
          return fast.promise;
        }
        throw new Error(`unexpected path: ${input.path}`);
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const slowLoad = controller.loadDirectory("/Users/demo/project/slow");
  const fastLoad = controller.loadDirectory("/Users/demo/project/fast");

  fast.resolve({
    directoryPath: "/Users/demo/project/fast",
    entries: [createFileEntry("/Users/demo/project/fast/newer.txt")],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await fastLoad;

  assert.equal(store.currentDirectoryPath, "/Users/demo/project/fast");
  assert.equal(store.entries[0]?.path, "/Users/demo/project/fast/newer.txt");

  slow.resolve({
    directoryPath: "/Users/demo/project/slow",
    entries: [createFileEntry("/Users/demo/project/slow/older.txt")],
    root: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  await slowLoad;

  assert.equal(store.currentDirectoryPath, "/Users/demo/project/fast");
  assert.equal(store.entries[0]?.path, "/Users/demo/project/fast/newer.txt");
  assert.equal(store.isLoading, false);
});

test("goBack restores the previous directory and moves current into forward history", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project/current";
  store.navigationBackStack = ["/Users/demo/project/previous"];
  store.selectedPath = "/Users/demo/project/current/file.txt";

  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        return {
          directoryPath: input.path,
          entries: [createFileEntry(`${input.path}/restored.txt`)],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.goBack();

  assert.equal(store.currentDirectoryPath, "/Users/demo/project/previous");
  assert.deepEqual(store.navigationForwardStack, [
    "/Users/demo/project/current"
  ]);
  assert.equal(store.selectedPath, null);
  assert.equal(
    store.entries[0]?.path,
    "/Users/demo/project/previous/restored.txt"
  );
});

test("revealPath loads the parent directory and selects the requested file", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "/Users/demo/project/src");
        return {
          directoryPath: input.path,
          entries: [createFileEntry("/Users/demo/project/src/index.ts")],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.revealPath("/Users/demo/project/src/index.ts");

  assert.equal(store.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(store.selectedPath, "/Users/demo/project/src/index.ts");
  assert.equal(store.isLoading, false);
});

test("revealPath loads external absolute parent directories outside the current root", async () => {
  const store = createTestStore();
  store.root = "/Users/demo";
  store.currentDirectoryPath = "/Users/demo";
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "/tmp");
        return {
          directoryPath: input.path,
          entries: [createFileEntry("/tmp/hello_world.md")],
          root: "/",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.revealPath("/tmp/hello_world.md");

  assert.equal(store.root, "/");
  assert.equal(store.currentDirectoryPath, "/tmp");
  assert.equal(store.selectedPath, "/tmp/hello_world.md");
  assert.equal(store.isLoading, false);
});

test("revealPath handles Windows drive paths outside the current root", async () => {
  const store = createTestStore();
  store.root = "C:/Users/demo";
  store.currentDirectoryPath = "C:/Users/demo";
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "C:/tmp");
        return {
          directoryPath: input.path,
          entries: [createFileEntry("C:/tmp/hello_world.md")],
          root: "C:/",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.revealPath("C:\\tmp\\hello_world.md");

  assert.equal(store.root, "C:/");
  assert.equal(store.currentDirectoryPath, "C:/tmp");
  assert.equal(store.selectedPath, "C:/tmp/hello_world.md");
  assert.equal(store.isLoading, false);
});

test("revealPath includes hidden entries when parent path contains a hidden segment", async () => {
  const store = createTestStore();
  store.root = "/Users/demo";
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(
          input.path,
          "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images"
        );
        assert.equal(input.includeHidden, true);
        return {
          directoryPath: input.path,
          entries: [
            createFileEntry(
              "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png"
            )
          ],
          root: "/Users/demo",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.revealPath(
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png"
  );

  assert.equal(
    store.currentDirectoryPath,
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images"
  );
  assert.equal(
    store.selectedPath,
    "/Users/demo/.tutti-dev/agent/runs/session-1/codex-home/generated_images/image.png"
  );
});

test("revealPath includes hidden entries when target file is hidden", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "/Users/demo/project");
        assert.equal(input.includeHidden, true);
        return {
          directoryPath: input.path,
          entries: [createFileEntry("/Users/demo/project/.env")],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.revealPath("/Users/demo/project/.env");

  assert.equal(store.currentDirectoryPath, "/Users/demo/project");
  assert.equal(store.selectedPath, "/Users/demo/project/.env");
});

test("superseded directory load still clears isLoading when no loads remain", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project";

  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        if (input.path === "/Users/demo/project") {
          await firstGate;
          return {
            directoryPath: input.path,
            entries: [createFileEntry("/Users/demo/project/a.txt")],
            root: "/Users/demo/project",
            workspaceID: input.workspaceID
          };
        }
        await secondGate;
        return {
          directoryPath: input.path,
          entries: [createFileEntry("/Users/demo/project/docs/b.txt")],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  const first = controller.loadDirectory("/Users/demo/project");
  const second = controller.loadDirectory("/Users/demo/project/docs");
  await Promise.resolve();
  assert.equal(store.isLoading, true);

  // Winner finishes first; superseded request must not leave isLoading latched.
  releaseSecond();
  await second;
  assert.equal(store.isLoading, false);
  assert.equal(store.currentDirectoryPath, "/Users/demo/project/docs");

  releaseFirst();
  await first;
  assert.equal(store.isLoading, false);
});

test("loadDirectory failure leaves existing selection in place and surfaces an error", async () => {
  const store = createTestStore();
  store.root = "/Users/demo/project";
  store.currentDirectoryPath = "/Users/demo/project";
  store.selectedPath = "/Users/demo/project/keep.txt";
  store.entries = [createFileEntry("/Users/demo/project/keep.txt")];

  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory() {
        throw new Error("directory load failed");
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.loadDirectory("/Users/demo/project/missing");

  assert.equal(store.error, "directory load failed");
  assert.equal(store.isLoading, false);
  assert.equal(store.currentDirectoryPath, "/Users/demo/project");
  assert.equal(store.selectedPath, "/Users/demo/project/keep.txt");
  assert.equal(store.entries[0]?.path, "/Users/demo/project/keep.txt");
});

test("initial directory load requests backend root before real root is known", async () => {
  const store = createTestStore();
  const controller = new WorkspaceFileManagerNavigationController({
    host: {
      async listDirectory(input) {
        assert.equal(input.path, "");
        return {
          directoryPath: "/Users/demo/project",
          entries: [createFileEntry("/Users/demo/project/README.md")],
          root: "/Users/demo/project",
          workspaceID: input.workspaceID
        };
      }
    },
    resolveErrorMessage: defaultResolveErrorMessage,
    store
  });

  await controller.loadDirectory();

  assert.equal(store.root, "/Users/demo/project");
  assert.equal(store.currentDirectoryPath, "/Users/demo/project");
  assert.deepEqual(store.navigationBackStack, []);
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function defaultResolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
