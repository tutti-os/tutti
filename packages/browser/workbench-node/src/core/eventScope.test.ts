import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrowserNodeEventNodeId,
  isBrowserNodeSurfaceEvent,
  isBrowserNodeSurfaceNodeId
} from "./eventScope.ts";
import type { BrowserNodeEvent } from "./types.ts";

const surfaceNodeId = "browser:standalone-agent-tool:one";

test("browser surface scope accepts its root and tab child node ids", () => {
  assert.equal(isBrowserNodeSurfaceNodeId(surfaceNodeId, surfaceNodeId), true);
  assert.equal(
    isBrowserNodeSurfaceNodeId(surfaceNodeId, `${surfaceNodeId}:tab:1`),
    true
  );
  assert.equal(
    isBrowserNodeSurfaceNodeId(surfaceNodeId, `${surfaceNodeId}:tab:12`),
    true
  );
});

test("browser surface scope rejects other roots and unrelated descendants", () => {
  assert.equal(
    isBrowserNodeSurfaceNodeId(
      surfaceNodeId,
      "browser:standalone-agent-tool:two:tab:1"
    ),
    false
  );
  assert.equal(
    isBrowserNodeSurfaceNodeId(surfaceNodeId, `${surfaceNodeId}:other:1`),
    false
  );
  assert.equal(
    isBrowserNodeSurfaceNodeId(surfaceNodeId, `${surfaceNodeId}-copy:tab:1`),
    false
  );
});

test("browser surface scope resolves open-url events through sourceNodeId", () => {
  const event = {
    sourceNodeId: `${surfaceNodeId}:tab:1`,
    type: "open-url",
    url: "https://example.com/"
  } satisfies BrowserNodeEvent;

  assert.equal(getBrowserNodeEventNodeId(event), `${surfaceNodeId}:tab:1`);
  assert.equal(isBrowserNodeSurfaceEvent(surfaceNodeId, event), true);
});

test("browser surface scope resolves runtime events through nodeId", () => {
  const event = {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: `${surfaceNodeId}:tab:1`,
    title: "Example",
    type: "state",
    url: "https://example.com/"
  } satisfies BrowserNodeEvent;

  assert.equal(getBrowserNodeEventNodeId(event), `${surfaceNodeId}:tab:1`);
  assert.equal(isBrowserNodeSurfaceEvent(surfaceNodeId, event), true);
});
