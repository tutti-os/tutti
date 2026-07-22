import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";
import { createDesktopWorkspaceFileReferenceAdapter } from "./createDesktopWorkspaceFileReferenceAdapter.ts";

test("desktop workspace file reference adapter lets tuttid resolve the local root", async () => {
  const calls: Array<{
    method: string;
    request:
      | {
          path?: string;
          prefetchBudgetMs?: number;
          prefetchDepth?: number;
        }
      | undefined;
  }> = [];
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {} as DesktopHostFilesApi,
    tuttidClient: {
      async getWorkspaceFileTreeSnapshot(
        _workspaceId: string,
        request:
          | {
              path?: string;
              prefetchBudgetMs?: number;
              prefetchDepth?: number;
            }
          | undefined
      ) {
        calls.push({ method: "tree", request });
        return {
          budgetExceeded: false,
          directory: {
            directoryPath: "/Users/test/project/tutti",
            entries: [
              {
                kind: "directory",
                name: "superpowers",
                path: "/Users/test/project/tutti/superpowers"
              }
            ],
            prefetchState: "loaded"
          },
          prefetchBudgetMs: 500,
          prefetchDepth: 4,
          root: "/Users/test/project/tutti"
        };
      },
      async listWorkspaceFileDirectory(
        _workspaceId: string,
        request: { path?: string } = {}
      ) {
        calls.push({ method: "list", request });
        return {
          directoryPath: "/Users/test/project/tutti",
          entries: [
            {
              kind: "directory",
              name: "superpowers",
              path: "/Users/test/project/tutti/superpowers"
            }
          ],
          root: "/Users/test/project/tutti",
          workspaceId: "workspace-1"
        };
      }
    } as unknown as TuttidClient,
    workspaceId: "workspace-1"
  });

  const snapshot = await adapter.loadReferenceTree?.({
    workspaceId: "workspace-1"
  });
  const listing = await adapter.listDirectory?.({
    workspaceId: "workspace-1"
  });

  assert.deepEqual(calls, [
    {
      method: "tree",
      request: {
        path: undefined,
        prefetchBudgetMs: 500,
        prefetchDepth: 4
      }
    },
    {
      method: "list",
      request: {
        path: undefined
      }
    }
  ]);
  assert.equal(snapshot?.rootPath, "/Users/test/project/tutti");
  assert.equal(
    snapshot?.directory.entries[0]?.path,
    "/Users/test/project/tutti/superpowers"
  );
  assert.equal(listing?.rootPath, "/Users/test/project/tutti");
  assert.equal(listing?.directoryPath, "/Users/test/project/tutti");
  assert.equal(
    listing?.entries[0]?.path,
    "/Users/test/project/tutti/superpowers"
  );
});

test("desktop workspace file reference adapter passes search abort signals to tuttid", async () => {
  const abortController = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {} as DesktopHostFilesApi,
    tuttidClient: {
      async searchWorkspaceFiles(
        _workspaceId: string,
        _request: Parameters<TuttidClient["searchWorkspaceFiles"]>[1],
        requestOptions?: Parameters<TuttidClient["searchWorkspaceFiles"]>[2]
      ) {
        observedSignal = requestOptions?.signal ?? undefined;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceId: "workspace-1"
        };
      }
    } as unknown as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.searchReferences?.({
    query: "tutti",
    signal: abortController.signal,
    workspaceId: "workspace-1"
  });

  assert.equal(observedSignal, abortController.signal);
});

test("desktop workspace file reference adapter maps reference kinds before search", async () => {
  let observedRequest:
    | Parameters<TuttidClient["searchWorkspaceFiles"]>[1]
    | undefined;
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {} as DesktopHostFilesApi,
    tuttidClient: {
      async searchWorkspaceFiles(
        _workspaceId: string,
        request: Parameters<TuttidClient["searchWorkspaceFiles"]>[1]
      ) {
        observedRequest = request;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceId: "workspace-1"
        };
      }
    } as unknown as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.searchReferences?.({
    query: "notes",
    kinds: ["file"],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(observedRequest?.includeKinds, ["file"]);
});

test("desktop workspace file reference adapter preserves file creation times from search", async () => {
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {} as DesktopHostFilesApi,
    tuttidClient: {
      async searchWorkspaceFiles() {
        return {
          entries: [
            {
              createdTimeMs: 1_800_000_000_000,
              kind: "file",
              lastOpenedMs: null,
              mtimeMs: 1_800_000_001_000,
              name: "prd.md",
              path: "/Users/test/prd.md",
              sizeBytes: 42
            }
          ],
          root: "/Users/test",
          workspaceId: "workspace-1"
        };
      }
    } as unknown as TuttidClient,
    workspaceId: "workspace-1"
  });

  const refs = await adapter.searchReferences?.({
    query: "prd",
    workspaceId: "workspace-1"
  });

  assert.equal(refs?.[0]?.createdTimeMs, 1_800_000_000_000);
});

test("desktop workspace file reference adapter opens previewable files with the preview presenter first", async () => {
  const calls: string[] = [];
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {
      async openFile() {
        calls.push("open-file");
      }
    } as unknown as DesktopHostFilesApi,
    presentFilePreview(target, workspaceId) {
      calls.push(`preview:${workspaceId}:${target.path}:${target.fileKind}`);
      return true;
    },
    tuttidClient: {} as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.openReference?.({
    kind: "file",
    path: "/workspace/image.png"
  });

  assert.deepEqual(calls, ["preview:workspace-1:/workspace/image.png:image"]);
});

test("desktop workspace file reference adapter falls back to system open when the preview presenter cannot handle the file", async () => {
  const calls: string[] = [];
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {
      async openFile(workspaceId: string, path: string) {
        calls.push(`open-file:${workspaceId}:${path}`);
      }
    } as unknown as DesktopHostFilesApi,
    presentFilePreview(target, workspaceId) {
      calls.push(`preview:${workspaceId}:${target.path}:${target.fileKind}`);
      return false;
    },
    tuttidClient: {} as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.openReference?.({
    kind: "file",
    path: "/workspace/image.png"
  });

  assert.deepEqual(calls, [
    "preview:workspace-1:/workspace/image.png:image",
    "open-file:workspace-1:/workspace/image.png"
  ]);
});

test("desktop workspace file reference adapter opens unsupported preview formats with the system default", async () => {
  const calls: string[] = [];
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {
      async openFile(workspaceId: string, path: string) {
        calls.push(`open-file:${workspaceId}:${path}`);
      }
    } as unknown as DesktopHostFilesApi,
    presentFilePreview() {
      calls.push("preview");
      return true;
    },
    tuttidClient: {} as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.openReference?.({
    kind: "file",
    path: "/workspace/deck.pptx"
  });

  assert.deepEqual(calls, ["open-file:workspace-1:/workspace/deck.pptx"]);
});

test("desktop workspace file reference adapter forwards within scope to tuttid", async () => {
  let observedRequest:
    | Parameters<TuttidClient["searchWorkspaceFiles"]>[1]
    | undefined;
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {} as DesktopHostFilesApi,
    tuttidClient: {
      async searchWorkspaceFiles(
        _workspaceId: string,
        request: Parameters<TuttidClient["searchWorkspaceFiles"]>[1]
      ) {
        observedRequest = request;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceId: "workspace-1"
        };
      }
    } as unknown as TuttidClient,
    workspaceId: "workspace-1"
  });

  await adapter.searchReferences?.({
    query: "report",
    within: "Documents",
    workspaceId: "workspace-1"
  });

  assert.equal(observedRequest?.within, "Documents");
});

test("desktop workspace file reference adapter reads video previews", async () => {
  const previewReads: Array<[string, string]> = [];
  const adapter = createDesktopWorkspaceFileReferenceAdapter({
    hostFilesApi: {
      async readPreviewFile(workspaceID, path) {
        previewReads.push([workspaceID, path]);
        return new Uint8Array([0x00, 0x00, 0x00, 0x18]);
      }
    } as DesktopHostFilesApi,
    tuttidClient: {} as TuttidClient,
    workspaceId: "workspace-1"
  });

  const videoPreview = await adapter.readReferencePreview?.({
    reference: {
      kind: "file",
      path: "/workspace/demo.mp4"
    },
    workspaceId: "workspace-2"
  });

  assert.deepEqual(videoPreview, {
    bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
    contentType: "video/mp4",
    kind: "video"
  });
  assert.deepEqual(previewReads, [["workspace-2", "/workspace/demo.mp4"]]);
});
