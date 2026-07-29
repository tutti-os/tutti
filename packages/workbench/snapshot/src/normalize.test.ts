import assert from "node:assert/strict";
import test from "node:test";
import {
  minimalWorkbenchSnapshotFixture,
  workbenchSnapshotWithSpacesFixture
} from "./fixtures.ts";
import {
  normalizeWorkbenchSnapshot,
  workbenchSnapshotSchemaVersion
} from "./index.ts";

test("normalizes ordering, defaults, and stack membership", () => {
  const normalized = normalizeWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "b",
        kind: "terminal",
        title: "B",
        frame: { x: -0, y: 3.14159, width: 200, height: 150 }
      },
      {
        id: "a",
        kind: "agent",
        title: "A",
        frame: { x: 10, y: 10, width: 180, height: 140 }
      }
    ],
    nodeStack: ["missing", "b"]
  });

  assert.deepEqual(
    normalized.nodes.map((node) => node.id),
    ["a", "b"]
  );
  assert.deepEqual(normalized.nodeStack, ["b", "a"]);
  assert.equal(normalized.activeNodeId, "a");
  assert.equal(normalized.nodes[1]?.frame.x, 0);
  assert.equal(normalized.nodes[1]?.frame.y, 3.142);
});

test("preserves minimized ordering timestamp only for minimized nodes", () => {
  const normalized = normalizeWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "a",
        kind: "textFile",
        title: "A",
        frame: { x: 0, y: 0, width: 200, height: 150 },
        isMinimized: true,
        minimizedAtUnixMs: 1720000000000
      },
      {
        id: "c",
        kind: "textFile",
        title: "C",
        frame: { x: 0, y: 0, width: 200, height: 150 },
        isMinimized: true
      },
      {
        id: "b",
        kind: "textFile",
        title: "B",
        frame: { x: 0, y: 0, width: 200, height: 150 },
        isMinimized: false,
        minimizedAtUnixMs: 1720000000001
      }
    ]
  });

  assert.equal(normalized.nodes[0]?.minimizedAtUnixMs, 1720000000000);
  assert.equal("minimizedAtUnixMs" in normalized.nodes[1]!, false);
  assert.equal("minimizedAtUnixMs" in normalized.nodes[2]!, false);
});

test("normalizes the minimal canonical contract fixture", () => {
  const normalized = normalizeWorkbenchSnapshot(
    minimalWorkbenchSnapshotFixture
  );

  assert.deepEqual(normalized, {
    ...minimalWorkbenchSnapshotFixture,
    activeSpaceId: null
  });
});

test("preserves spaces and restore frames from canonical contract fixtures", () => {
  const normalized = normalizeWorkbenchSnapshot(
    workbenchSnapshotWithSpacesFixture
  );

  assert.equal(normalized.nodes[0]?.displayMode, "fullscreen");
  assert.deepEqual(normalized.nodes[0]?.restoreFrame, {
    x: 24,
    y: 30,
    width: 420,
    height: 340
  });
  assert.equal(normalized.spaces?.[0]?.id, "space-1");
  assert.deepEqual(normalized.spaces?.[0]?.frame, {
    x: 40,
    y: 48,
    width: 640,
    height: 480
  });
  assert.equal(normalized.activeSpaceId, "space-1");
  assert.deepEqual(normalized.layoutBasis, {
    surfaceSize: { width: 1440, height: 900 },
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 88, left: 0 }
    }
  });
});
