import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceWindowChromeOptions } from "./workspaceWindowChrome.ts";

test("Windows workspace and agent modes use an overlaid native title bar", () => {
  const expected = {
    autoHideMenuBar: true,
    titleBarOverlay: {
      color: "rgba(0, 0, 0, 0)",
      height: 52,
      symbolColor: "rgba(255, 255, 255, 0.92)"
    },
    titleBarStyle: "hidden"
  };
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "workspace"),
    expected
  );
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "agent"),
    expected
  );
});

test("frameless agent windows keep their existing non-Windows chrome", () => {
  assert.deepEqual(resolveWorkspaceWindowChromeOptions("darwin", "agent"), {
    frame: false,
    maximizable: false
  });
  assert.deepEqual(resolveWorkspaceWindowChromeOptions("linux", "agent"), {
    frame: false,
    maximizable: false
  });
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("darwin", "workspace"),
    {}
  );
});
