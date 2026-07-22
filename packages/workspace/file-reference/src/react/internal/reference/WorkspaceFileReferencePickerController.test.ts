import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter
} from "../../../contracts/index.ts";
import { createWorkspaceFileReferencePickerController } from "./WorkspaceFileReferencePickerController.ts";

test("workspace file reference picker controller searches a query only once when results settle", async () => {
  let searchCount = 0;
  const adapter: WorkspaceFileReferenceAdapter = {
    async searchReferences() {
      searchCount += 1;
      return [
        {
          kind: "file",
          path: `/result-${searchCount}.md`
        }
      ];
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-search-once"
  });

  controller.open();
  controller.setSearchQuery("nd");
  await settlePromises();
  await settlePromises();

  assert.equal(searchCount, 1);
  assert.deepEqual(
    controller.getSnapshot().searchEntries.map((entry) => entry.path),
    ["/result-1.md"]
  );
});

test("workspace file reference picker controller cancels stale searches", async () => {
  const calls: Array<{
    query: string;
    resolve: (refs: WorkspaceFileReference[]) => void;
    signal?: AbortSignal;
  }> = [];
  const adapter: WorkspaceFileReferenceAdapter = {
    searchReferences({ query, signal }) {
      return new Promise<WorkspaceFileReference[]>((resolve) => {
        calls.push({
          query,
          resolve,
          signal
        });
      });
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-cancel-stale"
  });

  controller.open();
  controller.setSearchQuery("n");
  controller.setSearchQuery("nd");

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.signal?.aborted, true);
  assert.equal(calls[1]?.signal?.aborted, false);

  calls[0]?.resolve([
    {
      kind: "file",
      path: "/stale.md"
    }
  ]);
  calls[1]?.resolve([
    {
      kind: "file",
      path: "/fresh.md"
    }
  ]);
  await settlePromises();

  assert.deepEqual(
    controller.getSnapshot().searchEntries.map((entry) => entry.path),
    ["/fresh.md"]
  );
});

test("workspace file reference picker controller ignores results after close", async () => {
  let resolveSearch: ((refs: WorkspaceFileReference[]) => void) | null = null;
  const adapter: WorkspaceFileReferenceAdapter = {
    searchReferences() {
      return new Promise<WorkspaceFileReference[]>((resolve) => {
        resolveSearch = resolve;
      });
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-close"
  });

  controller.open();
  controller.setSearchQuery("nd");
  assert.equal(controller.getSnapshot().isSearchLoading, true);

  controller.close();
  if (!resolveSearch) {
    throw new Error("expected pending search resolver");
  }
  const completeSearch: (refs: WorkspaceFileReference[]) => void =
    resolveSearch;
  completeSearch([
    {
      kind: "file",
      path: "/late.md"
    }
  ]);
  await settlePromises();

  assert.equal(controller.getSnapshot().isSearchLoading, false);
  assert.deepEqual(controller.getSnapshot().searchEntries, []);
});

test("workspace file reference picker controller loads and expands browse folders", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async listDirectory({ path }) {
      if (path === "/workspace/src") {
        return {
          directoryPath: "/workspace/src",
          entries: [
            {
              kind: "file",
              path: "/workspace/src/index.ts"
            }
          ]
        };
      }
      return {
        directoryPath: "/workspace",
        entries: [
          {
            kind: "folder",
            path: "/workspace/src"
          }
        ]
      };
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-browse"
  });

  controller.open();
  await settlePromises();
  assert.equal(controller.getSnapshot().browseRootPath, "/workspace");

  controller.toggleFolder({
    kind: "folder",
    path: "/workspace/src"
  });
  await settlePromises();

  assert.equal(
    controller.getSnapshot().directoryStateByPath["/workspace/src"]?.loaded,
    true
  );
  assert.equal(
    controller.getSnapshot().expandedFolderPaths["/workspace/src"],
    true
  );
});

test("workspace file reference picker controller reveals initial paths", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async listDirectory({ path }) {
      if (path === "/workspace/src") {
        return {
          directoryPath: "/workspace/src",
          entries: [
            {
              kind: "file",
              path: "/workspace/src/index.ts"
            }
          ]
        };
      }
      return {
        directoryPath: "/workspace",
        entries: [
          {
            kind: "folder",
            path: "/workspace/src"
          }
        ]
      };
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-reveal"
  });

  controller.open();
  await settlePromises();
  const focusedPath = await controller.revealInitialPath(
    "/workspace/src/index.ts"
  );

  assert.equal(focusedPath, "/workspace/src/index.ts");
  assert.equal(controller.getSnapshot().initialPathRevealed, true);
  assert.equal(
    controller.getSnapshot().expandedFolderPaths["/workspace/src"],
    true
  );
});

test("workspace file reference picker controller ignores stale preview results", async () => {
  const calls: Array<{
    path: string;
    resolve: (preview: { bytes: Uint8Array; kind: "text" }) => void;
  }> = [];
  const adapter: WorkspaceFileReferenceAdapter = {
    readReferencePreview({ reference }) {
      return new Promise((resolve) => {
        calls.push({
          path: reference.path,
          resolve
        });
      });
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-preview"
  });

  controller.open();
  controller.setPreviewReference({
    kind: "file",
    path: "/workspace/stale.txt"
  });
  controller.setPreviewReference({
    kind: "file",
    path: "/workspace/fresh.txt"
  });

  assert.equal(calls.length, 2);
  calls[0]?.resolve({
    bytes: new TextEncoder().encode("stale"),
    kind: "text"
  });
  calls[1]?.resolve({
    bytes: new TextEncoder().encode("fresh"),
    kind: "text"
  });
  await settlePromises();

  assert.deepEqual(controller.getSnapshot().previewState, {
    content: "fresh",
    previewKind: "text",
    reference: {
      kind: "file",
      path: "/workspace/fresh.txt"
    },
    status: "text"
  });
});

test("workspace file reference picker controller loads video previews", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async readReferencePreview() {
      return {
        bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
        contentType: "video/mp4",
        kind: "video"
      };
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-video"
  });

  controller.open();
  controller.setPreviewReference({
    kind: "file",
    path: "/workspace/demo.mp4"
  });
  await settlePromises();

  const previewState = controller.getSnapshot().previewState;
  assert.equal(previewState.status, "video");
  assert.equal(
    previewState.status === "video" ? previewState.reference.path : null,
    "/workspace/demo.mp4"
  );
  assert.match(
    previewState.status === "video" ? previewState.objectUrl : "",
    /^blob:/u
  );
  controller.close();
});

test("workspace file reference picker controller shows html source as text", async () => {
  const content = "<!doctype html><h1>Hello</h1>";
  const adapter: WorkspaceFileReferenceAdapter = {
    async readReferencePreview() {
      return {
        bytes: new TextEncoder().encode(content),
        contentType: "text/html",
        kind: "text"
      };
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-html-source"
  });

  controller.open();
  controller.setPreviewReference({
    kind: "file",
    path: "/workspace/login.html"
  });
  await settlePromises();

  assert.deepEqual(controller.getSnapshot().previewState, {
    content,
    previewKind: "text",
    reference: {
      kind: "file",
      path: "/workspace/login.html"
    },
    status: "text"
  });
  controller.close();
});

test("workspace file reference picker controller keeps a slow root load when expanding another folder", async () => {
  // 复现并发竞态:根目录加载在途时展开另一文件夹(不同 key)。全局单 sequence 会把
  // 迟到的根结果作废、令 isBrowseLoading 永不复位;按 key 隔离后两者互不影响。
  let resolveRoot!: (value: {
    directoryPath: string;
    entries: { kind: "file" | "folder"; path: string }[];
  }) => void;
  const pendingRoot = new Promise<{
    directoryPath: string;
    entries: { kind: "file" | "folder"; path: string }[];
  }>((resolve) => {
    resolveRoot = resolve;
  });
  const adapter: WorkspaceFileReferenceAdapter = {
    async listDirectory({ path }) {
      if (path === "/workspace/src") {
        return {
          directoryPath: "/workspace/src",
          entries: [{ kind: "file", path: "/workspace/src/index.ts" }]
        };
      }
      return pendingRoot;
    }
  };
  const controller = createWorkspaceFileReferencePickerController({
    fileAdapter: adapter,
    searchDebounceMs: 0,
    workspaceId: "workspace-concurrent"
  });

  controller.open(); // 触发根加载(在途)。
  await settlePromises();
  // 根仍在途时展开另一文件夹(不同 key),其加载立即完成、推进全局 ticket。
  controller.toggleFolder({ kind: "folder", path: "/workspace/src" });
  await settlePromises();
  // 现在根才返回:旧实现里它已被作废。
  resolveRoot({
    directoryPath: "/workspace",
    entries: [{ kind: "folder", path: "/workspace/src" }]
  });
  await settlePromises();

  assert.equal(controller.getSnapshot().browseRootPath, "/workspace");
  assert.equal(controller.getSnapshot().isBrowseLoading, false);
  assert.equal(
    controller.getSnapshot().directoryStateByPath["/workspace"]?.loaded,
    true
  );
});

function settlePromises(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
