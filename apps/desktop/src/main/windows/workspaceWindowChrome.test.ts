import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceWindowChromeOptions,
  resolveWorkspaceWindowTitleBarOverlay
} from "./workspaceWindowChrome.ts";

test("Windows title-bar symbols follow the active light and dark appearance", () => {
  assert.deepEqual(resolveWorkspaceWindowTitleBarOverlay("light"), {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    symbolColor: "rgba(17, 24, 39, 0.88)"
  });
  assert.deepEqual(resolveWorkspaceWindowTitleBarOverlay("dark"), {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    symbolColor: "rgba(255, 255, 255, 0.92)"
  });
});

test("Windows workspace chrome uses the requested appearance", () => {
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "workspace", "light")
      .titleBarOverlay,
    resolveWorkspaceWindowTitleBarOverlay("light")
  );
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "agent", "dark")
      .titleBarOverlay,
    resolveWorkspaceWindowTitleBarOverlay("dark")
  );
});
