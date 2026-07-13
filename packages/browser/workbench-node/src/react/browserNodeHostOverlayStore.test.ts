import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrowserNodeHostOverlayOpen,
  setBrowserNodeHostOverlayOwnerOpen,
  subscribeBrowserNodeHostOverlay
} from "./browserNodeHostOverlayStore.ts";

test("keeps a Browser Node webview hidden until every host overlay closes", () => {
  const nodeId = "browser-overlay-test";
  const snapshots: boolean[] = [];
  const unsubscribe = subscribeBrowserNodeHostOverlay(nodeId, () => {
    snapshots.push(isBrowserNodeHostOverlayOpen(nodeId));
  });

  setBrowserNodeHostOverlayOwnerOpen({ nodeId, open: true, ownerId: "menu" });
  setBrowserNodeHostOverlayOwnerOpen({ nodeId, open: true, ownerId: "dialog" });
  setBrowserNodeHostOverlayOwnerOpen({ nodeId, open: false, ownerId: "menu" });

  assert.equal(isBrowserNodeHostOverlayOpen(nodeId), true);
  assert.deepEqual(snapshots, [true]);

  setBrowserNodeHostOverlayOwnerOpen({
    nodeId,
    open: false,
    ownerId: "dialog"
  });

  assert.equal(isBrowserNodeHostOverlayOpen(nodeId), false);
  assert.deepEqual(snapshots, [true, false]);
  unsubscribe();
});
