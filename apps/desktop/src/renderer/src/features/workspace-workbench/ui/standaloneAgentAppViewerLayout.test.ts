import assert from "node:assert/strict";
import test from "node:test";
import { syncStandaloneAgentAppViewerWebviewBounds } from "./standaloneAgentAppViewerLayout.ts";

test("standalone Agent app viewer keeps the Electron webview bound to its live host", () => {
  const webview = { style: { height: "150px", width: "300px" } };
  const surface = {
    clientHeight: 468,
    clientWidth: 796,
    querySelector: () => webview
  };

  assert.equal(syncStandaloneAgentAppViewerWebviewBounds(surface), true);
  assert.deepEqual(webview.style, { height: "100%", width: "100%" });

  surface.clientHeight = 620;
  surface.clientWidth = 1040;
  assert.equal(syncStandaloneAgentAppViewerWebviewBounds(surface), true);
  assert.deepEqual(webview.style, { height: "100%", width: "100%" });
});

test("standalone Agent app viewer waits until its hidden surface has layout bounds", () => {
  const webview = { style: { height: "150px", width: "300px" } };
  const surface = {
    clientHeight: 0,
    clientWidth: 796,
    querySelector: () => webview
  };

  assert.equal(syncStandaloneAgentAppViewerWebviewBounds(surface), false);
  assert.deepEqual(webview.style, { height: "150px", width: "300px" });
});
