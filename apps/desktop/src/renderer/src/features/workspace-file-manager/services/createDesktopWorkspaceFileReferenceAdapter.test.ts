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
