import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceWorkbenchLayoutConstraints } from "./workspaceWorkbenchLayoutConstraints.ts";

test("workspace workbench safe area follows dock placement", () => {
  assert.deepEqual(resolveWorkspaceWorkbenchLayoutConstraints("bottom"), {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: 52,
      left: 0,
      bottom: 79
    }
  });

  assert.deepEqual(resolveWorkspaceWorkbenchLayoutConstraints("left"), {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: 52,
      bottom: 0,
      left: 80
    }
  });
});

test("auto-hide chrome gives workbench windows the complete surface", () => {
  const expected = {
    minWidth: 280,
    minHeight: 160,
    surfacePadding: 0,
    safeArea: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    }
  };

  assert.deepEqual(
    resolveWorkspaceWorkbenchLayoutConstraints("bottom", true),
    expected
  );
  assert.deepEqual(
    resolveWorkspaceWorkbenchLayoutConstraints("left", true),
    expected
  );
});
