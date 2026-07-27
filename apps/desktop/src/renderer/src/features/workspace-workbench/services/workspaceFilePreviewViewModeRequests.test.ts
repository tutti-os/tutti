import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceFilePreviewWindowViewModeRequestSource,
  requestWorkspaceFilePreviewViewMode,
  type WorkspaceFilePreviewTextViewMode
} from "./workspaceFilePreviewViewModeRequests.ts";

test("workspace file preview view mode requests are scoped to one node", () => {
  const target = new EventTarget();
  const source = createWorkspaceFilePreviewWindowViewModeRequestSource(
    target as Pick<Window, "addEventListener" | "removeEventListener">
  );
  const received: WorkspaceFilePreviewTextViewMode[] = [];
  const unsubscribe = source.subscribe("node-a", (mode) => {
    received.push(mode);
  });

  requestWorkspaceFilePreviewViewMode(
    "node-b",
    "preview",
    target as Pick<Window, "dispatchEvent">
  );
  requestWorkspaceFilePreviewViewMode(
    "node-a",
    "preview",
    target as Pick<Window, "dispatchEvent">
  );
  requestWorkspaceFilePreviewViewMode(
    "node-a",
    "edit",
    target as Pick<Window, "dispatchEvent">
  );

  assert.deepEqual(received, ["preview", "edit"]);

  unsubscribe();
  requestWorkspaceFilePreviewViewMode(
    "node-a",
    "preview",
    target as Pick<Window, "dispatchEvent">
  );
  assert.deepEqual(received, ["preview", "edit"]);
});
