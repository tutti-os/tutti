import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type { WorkspaceFilePreviewActivationTarget } from "@tutti-os/workspace-file-preview";
import { createWorkspaceFilePreviewLaunchRequest } from "./workspaceFilePreviewLaunch.ts";
import { createWorkbenchWorkspaceFilePreviewPresenter } from "./workbenchWorkspaceFilePreviewPresenter.ts";

const target: WorkspaceFilePreviewActivationTarget = {
  fileKind: "image",
  mtimeMs: 1,
  name: "cover.png",
  path: "/workspace/cover.png",
  sizeBytes: 10
};

test("workbench file preview presenter launches a workbench node", async () => {
  const launches: unknown[] = [];
  const presenter = createWorkbenchWorkspaceFilePreviewPresenter({
    host: {
      launchNode: async (request) => {
        launches.push(request);
        return "preview-node";
      }
    } as WorkbenchHostHandle
  });

  assert.equal(await presenter.present(target), true);
  assert.deepEqual(launches, [createWorkspaceFilePreviewLaunchRequest(target)]);
  assert.equal(presenter.unsupportedFallbackNotification, "show");
});

test("workbench file preview presenter reports a rejected launch", async () => {
  const presenter = createWorkbenchWorkspaceFilePreviewPresenter({
    host: { launchNode: async () => null } as unknown as WorkbenchHostHandle
  });

  assert.equal(await presenter.present(target), false);
});
