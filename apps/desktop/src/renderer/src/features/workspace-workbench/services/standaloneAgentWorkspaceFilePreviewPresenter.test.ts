import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneAgentWorkspaceFilePreviewPresenter } from "./standaloneAgentWorkspaceFilePreviewPresenter.ts";

test("standalone Agent file previews stay in the right-side Files tool", async () => {
  const openedPaths: string[] = [];
  const presenter = createStandaloneAgentWorkspaceFilePreviewPresenter({
    openFile(path) {
      openedPaths.push(path);
      return true;
    }
  });

  const presented = await presenter.present({
    name: "README.md",
    path: "/workspace/README.md",
    previewKind: "markdown"
  });

  assert.equal(presented, true);
  assert.deepEqual(openedPaths, ["/workspace/README.md"]);
});
