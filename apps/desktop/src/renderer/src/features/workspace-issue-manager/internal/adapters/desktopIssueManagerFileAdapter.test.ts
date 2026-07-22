import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";
import { createDesktopIssueManagerFileAdapter } from "./desktopIssueManagerFileAdapter.ts";

test("desktop issue-manager file adapter normalizes directory listings and search results", async () => {
  const openCalls: Array<[string, string]> = [];
  const terminalOpenCalls: Array<[string, string]> = [];
  const fileManagerOpenCalls: string[] = [];
  const adapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: {
      async openFile(workspaceID, path) {
        openCalls.push([workspaceID, path]);
      },
      async openTerminalLink(input) {
        terminalOpenCalls.push([input.workspaceID, input.path]);
      }
    } as DesktopHostFilesApi,
    tuttidClient: createTuttidClient({
      async listWorkspaceFileDirectory(workspaceID, request) {
        assert.equal(workspaceID, "workspace-1");
        assert.deepEqual(request, { path: "/workspace/docs" });
        return {
          directoryPath: "/workspace/docs",
          entries: [
            {
              kind: "directory",
              name: "guides",
              path: "/workspace/docs/guides/"
            },
            { kind: "file", name: "spec.md", path: "/workspace/docs/spec.md" }
          ],
          root: "/workspace"
        } as never;
      },
      async searchWorkspaceFiles(workspaceID, request) {
        assert.equal(workspaceID, "workspace-2");
        assert.deepEqual(request, {
          limit: 5,
          query: "spec"
        });
        return {
          entries: [
            {
              kind: "directory",
              name: "guides",
              path: "/workspace/docs/guides/"
            },
            { kind: "file", name: "spec.md", path: "/workspace/docs/spec.md" }
          ]
        } as never;
      },
      async getWorkspaceFileTreeSnapshot(workspaceID, request) {
        assert.equal(workspaceID, "workspace-1");
        assert.deepEqual(request, {
          path: "/workspace/docs",
          prefetchBudgetMs: 300,
          prefetchDepth: 2
        });
        return {
          budgetExceeded: true,
          directory: {
            directoryPath: "/workspace/docs",
            entries: [
              {
                hasChildren: true,
                kind: "directory",
                name: "guides",
                path: "/workspace/docs/guides",
                prefetchedDirectory: {
                  directoryPath: "/workspace/docs/guides",
                  entries: [],
                  prefetchState: "loaded"
                },
                prefetchState: "loaded"
              }
            ],
            prefetchState: "partial",
            prefetchReason: "budget_exhausted"
          },
          prefetchBudgetMs: 300,
          prefetchDepth: 2,
          root: "/workspace"
        } as never;
      }
    }),
    async openWorkspaceFileManager(reference) {
      fileManagerOpenCalls.push(reference.path);
      return true;
    },
    workspaceId: "workspace-1"
  });

  const directory = await adapter.listDirectory!({
    path: "/workspace/docs",
    workspaceId: "workspace-1"
  });
  const results = await adapter.searchReferences!({
    limit: 5,
    query: "spec",
    workspaceId: "workspace-2"
  });
  const snapshot = await adapter.loadReferenceTree!({
    path: "/workspace/docs",
    prefetchBudgetMs: 300,
    prefetchDepth: 2,
    workspaceId: "workspace-1"
  });
  await adapter.openReference!({
    kind: "file",
    path: "/workspace/docs/spec.md"
  });
  await adapter.openReference!({
    kind: "file",
    path: "~/docs/spec.md"
  });

  assert.deepEqual(directory, {
    directoryPath: "/workspace/docs",
    entries: [
      {
        displayName: "guides",
        kind: "folder",
        path: "/workspace/docs/guides/"
      },
      {
        displayName: "spec.md",
        kind: "file",
        path: "/workspace/docs/spec.md"
      }
    ],
    rootPath: "/workspace"
  });
  assert.deepEqual(results, [
    {
      displayName: "guides",
      kind: "folder",
      path: "/workspace/docs/guides/"
    },
    {
      displayName: "spec.md",
      kind: "file",
      path: "/workspace/docs/spec.md"
    }
  ]);
  assert.deepEqual(snapshot, {
    budgetExceeded: true,
    directory: {
      directoryPath: "/workspace/docs",
      entries: [
        {
          displayName: "guides",
          hasChildren: true,
          kind: "folder",
          path: "/workspace/docs/guides",
          prefetchedDirectory: {
            directoryPath: "/workspace/docs/guides",
            entries: [],
            prefetchState: "loaded",
            prefetchReason: undefined
          },
          prefetchReason: undefined,
          prefetchState: "loaded"
        }
      ],
      prefetchReason: "budget_exhausted",
      prefetchState: "partial"
    },
    prefetchBudgetMs: 300,
    prefetchDepth: 2,
    rootPath: "/workspace"
  });
  assert.deepEqual(fileManagerOpenCalls, ["/workspace/docs/spec.md"]);
  assert.deepEqual(openCalls, []);
  assert.deepEqual(terminalOpenCalls, [["workspace-1", "~/docs/spec.md"]]);
});

test("desktop issue-manager file adapter falls back to host file open when file manager launch is unavailable", async () => {
  const openCalls: Array<[string, string]> = [];
  const terminalOpenCalls: Array<[string, string]> = [];
  const adapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: {
      async openFile(workspaceID, path) {
        openCalls.push([workspaceID, path]);
      },
      async openTerminalLink(input) {
        terminalOpenCalls.push([input.workspaceID, input.path]);
      }
    } as DesktopHostFilesApi,
    tuttidClient: createTuttidClient({}),
    async openWorkspaceFileManager() {
      return false;
    },
    workspaceId: "workspace-1"
  });

  await adapter.openReference!({
    kind: "file",
    path: "/workspace/docs/spec.md"
  });
  await adapter.openReference!({
    kind: "file",
    path: "/tmp/spec.md"
  });

  assert.deepEqual(openCalls, [["workspace-1", "/workspace/docs/spec.md"]]);
  assert.deepEqual(terminalOpenCalls, [["workspace-1", "/tmp/spec.md"]]);
});

test("desktop issue-manager file adapter uploads selected files through tuttid", async () => {
  const adapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: {
      async selectUploadFiles() {
        return ["/tmp/spec.md", "/tmp/plan.md"];
      }
    } as DesktopHostFilesApi,
    tuttidClient: createTuttidClient({
      async preflightUploadWorkspaceFiles(workspaceID, request) {
        assert.equal(workspaceID, "workspace-1");
        assert.deepEqual(request, {
          sourcePaths: ["/tmp/spec.md", "/tmp/plan.md"],
          targetDirectoryPath: "/workspace/docs"
        });
        return {
          conflicts: [{ kind: "replace", path: "/workspace/docs/spec.md" }]
        } as never;
      },
      async uploadWorkspaceFiles(workspaceID, request) {
        assert.equal(workspaceID, "workspace-1");
        assert.deepEqual(request, {
          overwrite: true,
          sourcePaths: ["/tmp/spec.md", "/tmp/plan.md"],
          targetDirectoryPath: "/workspace/docs"
        });
        return {
          entries: [
            { kind: "file", name: "spec.md", path: "/workspace/docs/spec.md" },
            { kind: "file", name: "plan.md", path: "/workspace/docs/plan.md" }
          ]
        } as never;
      }
    }),
    workspaceId: "workspace-1"
  });

  const uploaded = await adapter.requestUpload!({
    mode: "files",
    targetDirectoryPath: "/workspace/docs",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(uploaded, [
    {
      displayName: "spec.md",
      kind: "file",
      path: "/workspace/docs/spec.md"
    },
    {
      displayName: "plan.md",
      kind: "file",
      path: "/workspace/docs/plan.md"
    }
  ]);
});

test("desktop issue-manager file adapter uses directory picker and rejects type mismatch conflicts", async () => {
  const adapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: {
      async selectDirectory() {
        return "/tmp/docs";
      }
    } as DesktopHostFilesApi,
    tuttidClient: createTuttidClient({
      async preflightUploadWorkspaceFiles() {
        return {
          conflicts: [{ kind: "type_mismatch", path: "/workspace/docs" }]
        } as never;
      }
    }),
    workspaceId: "workspace-1"
  });

  await assert.rejects(
    () =>
      adapter.requestUpload!({
        mode: "folder",
        targetDirectoryPath: "/workspace",
        workspaceId: "workspace-1"
      }),
    /issue_manager\.upload_type_conflict/
  );
});

test("desktop issue-manager file adapter reads image and text previews", async () => {
  const previewReads: Array<[string, string]> = [];
  const adapter = createDesktopIssueManagerFileAdapter({
    hostFilesApi: {
      async readPreviewFile(workspaceID, path) {
        previewReads.push([workspaceID, path]);
        return path.endsWith(".png")
          ? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
          : new TextEncoder().encode("hello");
      }
    } as DesktopHostFilesApi,
    tuttidClient: createTuttidClient({}),
    workspaceId: "workspace-1"
  });

  const imagePreview = await adapter.readReferencePreview!({
    reference: {
      displayName: "mock.png",
      kind: "file",
      path: "/workspace/mock.png"
    },
    workspaceId: "workspace-1"
  });
  const textPreview = await adapter.readReferencePreview!({
    reference: {
      kind: "file",
      path: "/workspace/notes.md"
    },
    workspaceId: "workspace-2"
  });
  const unsupportedPreview = await adapter.readReferencePreview!({
    reference: {
      kind: "file",
      path: "/workspace/archive.zip"
    },
    workspaceId: "workspace-1"
  });
  const terminalPreview = await adapter.readReferencePreview!({
    reference: {
      kind: "file",
      path: "~/notes.md"
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(imagePreview, {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png",
    kind: "image"
  });
  assert.deepEqual(textPreview, {
    bytes: new TextEncoder().encode("hello"),
    contentType: "text/plain;charset=utf-8",
    kind: "markdown"
  });
  assert.equal(unsupportedPreview, null);
  assert.equal(terminalPreview, null);
  assert.deepEqual(previewReads, [
    ["workspace-1", "/workspace/mock.png"],
    ["workspace-2", "/workspace/notes.md"]
  ]);
});

function createTuttidClient(overrides: Partial<TuttidClient>): TuttidClient {
  return overrides as TuttidClient;
}
