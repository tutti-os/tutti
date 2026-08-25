import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceWindowChromeOptions,
  resolveWorkspaceWindowTitleBarOverlay,
  syncWorkspaceWindowTitleBarOverlayTargets
} from "./workspaceWindowChrome.ts";

test("Windows Agent title-bar symbols follow the active appearance", () => {
  assert.deepEqual(resolveWorkspaceWindowTitleBarOverlay("light", "agent"), {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    symbolColor: "rgba(17, 24, 39, 0.88)"
  });
  assert.deepEqual(resolveWorkspaceWindowTitleBarOverlay("dark", "agent"), {
    color: "rgba(0, 0, 0, 0)",
    height: 52,
    symbolColor: "rgba(255, 255, 255, 0.92)"
  });
});

test("Windows OS workspace title-bar symbols stay visible over its dark chrome", () => {
  for (const appearance of ["light", "dark"] as const) {
    assert.deepEqual(
      resolveWorkspaceWindowTitleBarOverlay(appearance, "workspace"),
      {
        color: "rgba(0, 0, 0, 0)",
        height: 52,
        symbolColor: "rgba(255, 255, 255, 0.92)"
      }
    );
  }
});

test("Windows workspace chrome uses the matching window surface", () => {
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "workspace", "light")
      .titleBarOverlay,
    resolveWorkspaceWindowTitleBarOverlay("light", "workspace")
  );
  assert.deepEqual(
    resolveWorkspaceWindowChromeOptions("win32", "agent", "dark")
      .titleBarOverlay,
    resolveWorkspaceWindowTitleBarOverlay("dark", "agent")
  );
});

test("runtime title-bar sync applies each registered window surface independently", () => {
  type Target = {
    destroyed?: boolean;
    kind: "agent" | "workspace" | null;
    name: string;
  };
  const targets: Target[] = [
    { kind: "agent", name: "agent" },
    { kind: "workspace", name: "workspace" },
    { destroyed: true, kind: "workspace", name: "destroyed" },
    { kind: null, name: "unregistered" }
  ];
  const applied: Array<{ name: string; symbolColor: string }> = [];

  syncWorkspaceWindowTitleBarOverlayTargets({
    appearance: "light",
    getWindowKind: (target) => target.kind,
    isDestroyed: (target) => target.destroyed === true,
    setTitleBarOverlay: (target, overlay) =>
      applied.push({ name: target.name, symbolColor: overlay.symbolColor }),
    targets
  });

  assert.deepEqual(applied, [
    { name: "agent", symbolColor: "rgba(17, 24, 39, 0.88)" },
    { name: "workspace", symbolColor: "rgba(255, 255, 255, 0.92)" }
  ]);
});
