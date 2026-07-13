import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFusionWindowLoadMetadata } from "./fusionWindowLoadMetadata.ts";
import { toElectronGlobalShortcutAccelerator } from "./fusionGlobalShortcut.ts";

const coordinatorSource = await readFile(
  new URL("./fusionWindowCoordinator.ts", import.meta.url),
  "utf8"
);

test("toElectronGlobalShortcutAccelerator converts stored shortcut syntax", () => {
  assert.equal(
    toElectronGlobalShortcutAccelerator("Ctrl+Shift+Space", "darwin"),
    "Control+Shift+Space"
  );
  assert.equal(toElectronGlobalShortcutAccelerator("Space", "darwin"), null);
  assert.equal(toElectronGlobalShortcutAccelerator("F8", "darwin"), "F8");
});

test("toElectronGlobalShortcutAccelerator rejects ambiguous bindings", () => {
  assert.equal(
    toElectronGlobalShortcutAccelerator("Foo+Shift+Space", "darwin"),
    null
  );
  assert.equal(
    toElectronGlobalShortcutAccelerator("Meta+Shift+Space+X", "darwin"),
    null
  );
  assert.equal(
    toElectronGlobalShortcutAccelerator("Meta+Shift+Shift+Space", "darwin"),
    null
  );
  assert.equal(
    toElectronGlobalShortcutAccelerator("Ctrl+Control+Space", "darwin"),
    null
  );
  assert.equal(
    toElectronGlobalShortcutAccelerator("Meta++Space", "darwin"),
    null
  );
});

test("Fusion coordinator load metadata preserves Agent payload opaquely", () => {
  const launchPayload = {
    arbitrary: { nested: ["value", 7] },
    provider: "future-provider"
  };
  const metadata = createFusionWindowLoadMetadata(
    {
      createdAtUnixMs: 1,
      focused: false,
      kind: "agent",
      lastFocusedAtUnixMs: 1,
      resourceId: "session-1",
      title: null,
      visibility: "visible",
      windowInstanceId: "window-1",
      workspaceId: "workspace-1"
    },
    launchPayload
  );

  assert.equal(metadata.launchPayload, launchPayload);
  assert.deepEqual(metadata, {
    launchPayload,
    resourceID: "session-1",
    windowInstanceID: "window-1"
  });
});

test("Fusion coordinator reconciles an existing Dock to the current presentation width", () => {
  assert.match(
    coordinatorSource,
    /if \(this\.#dockWindow && !this\.#dockWindow\.isDestroyed\(\)\) \{\s*this\.#reconcileDockWindowWidth\(this\.#dockWindow, false\);/
  );
  assert.match(
    coordinatorSource,
    /#reconcileDockWindowWidth\(dockWindow: BrowserWindow, animate: boolean\)/
  );
  assert.match(coordinatorSource, /this\.#scheduleDockBoundsWrite\(\);/);
});
