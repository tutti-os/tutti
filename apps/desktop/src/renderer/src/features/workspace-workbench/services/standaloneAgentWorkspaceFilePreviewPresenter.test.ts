import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import { createStandaloneAgentWorkspaceFilePreviewPresenter } from "./standaloneAgentWorkspaceFilePreviewPresenter.ts";

test("standalone Agent file preview presenter opens the file with the system host", async () => {
  const calls: Array<{ path: string; workspaceId: string }> = [];
  const presenter = createStandaloneAgentWorkspaceFilePreviewPresenter({
    hostFilesApi: {
      async openFile(workspaceId, path) {
        calls.push({ path, workspaceId });
      }
    },
    workspaceId: "workspace-1"
  });
  const target: WorkspaceFilePreviewTarget = {
    previewKind: "text",
    mtimeMs: null,
    name: "notes.txt",
    path: "/workspace/notes.txt",
    sizeBytes: 5
  };

  assert.equal(await presenter.present(target), true);
  assert.deepEqual(calls, [
    { path: "/workspace/notes.txt", workspaceId: "workspace-1" }
  ]);
  assert.equal(presenter.unsupportedFallbackNotification, "suppress");
});
