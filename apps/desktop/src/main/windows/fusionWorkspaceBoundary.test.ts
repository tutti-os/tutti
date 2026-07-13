import assert from "node:assert/strict";
import test from "node:test";
import { fusionWorkspaceRequiresDockReload } from "./fusionWorkspaceBoundary.ts";

test("Fusion Dock reloads only when the active workspace changes", () => {
  assert.equal(fusionWorkspaceRequiresDockReload(null, "workspace-a"), false);
  assert.equal(
    fusionWorkspaceRequiresDockReload("workspace-a", "workspace-a"),
    false
  );
  assert.equal(
    fusionWorkspaceRequiresDockReload("workspace-a", "workspace-b"),
    true
  );
});
