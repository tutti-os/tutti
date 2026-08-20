import assert from "node:assert/strict";
import test from "node:test";
import { supportsWorkspaceWindowCloseGuard } from "./workspaceWindowCloseGuard.ts";

test("workspace window close guard supports native Windows and macOS closes", () => {
  assert.equal(supportsWorkspaceWindowCloseGuard("win32"), true);
  assert.equal(supportsWorkspaceWindowCloseGuard("darwin"), true);
});

test("workspace window close guard does not change Linux behavior", () => {
  assert.equal(supportsWorkspaceWindowCloseGuard("linux"), false);
});
