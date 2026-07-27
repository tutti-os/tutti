import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicateNodeIDWorkbenchSnapshotFixture,
  invalidDisplayModeWorkbenchSnapshotFixture,
  invalidFrameWorkbenchSnapshotFixture,
  minimalWorkbenchSnapshotFixture,
  tuttiWorkbenchSnapshotFixture,
  oversizedWorkbenchSnapshotFixture,
  workbenchSnapshotWithSpacesFixture
} from "./fixtures.ts";
import {
  validateWorkbenchSnapshot,
  workbenchSnapshotSchemaVersion
} from "./index.ts";

test("rejects malformed snapshots", () => {
  const result = validateWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "",
        kind: "terminal",
        title: "Bad",
        frame: { x: 0, y: 0, width: 1, height: Number.NaN },
        displayMode: "popped"
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "nodes[0].id"));
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].frame.width")
  );
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].displayMode")
  );
});

test("rejects invalid minimized timestamps", () => {
  const result = validateWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "node-1",
        kind: "terminal",
        title: "Terminal",
        frame: { x: 0, y: 0, width: 320, height: 240 },
        isMinimized: true,
        minimizedAtUnixMs: -1
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].minimizedAtUnixMs")
  );
});

test("rejects malformed layout bases", () => {
  const result = validateWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [],
    layoutBasis: {
      surfaceSize: { width: 0, height: 800 },
      layoutConstraints: {
        minWidth: 280,
        minHeight: 160,
        surfacePadding: -1,
        safeArea: { top: 52, right: 0, bottom: 88, left: 0 }
      }
    }
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "layoutBasis.surfaceSize.width"
    )
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.path === "layoutBasis.layoutConstraints.surfacePadding"
    )
  );
});

test("rejects deprecated renderer node fields", () => {
  const result = validateWorkbenchSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "node-1",
        kind: "terminal",
        title: "Terminal",
        frame: { x: 0, y: 0, width: 320, height: 240 },
        position: { x: 0, y: 0 },
        selected: true,
        zIndex: 10
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "nodes[0].position"));
  assert.ok(result.issues.some((issue) => issue.path === "nodes[0].selected"));
  assert.ok(result.issues.some((issue) => issue.path === "nodes[0].zIndex"));
});

test("accepts canonical contract fixtures", () => {
  for (const fixture of [
    minimalWorkbenchSnapshotFixture,
    tuttiWorkbenchSnapshotFixture,
    workbenchSnapshotWithSpacesFixture
  ]) {
    const result = validateWorkbenchSnapshot(fixture);
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  }
});

test("rejects duplicate node ids from canonical contract fixtures", () => {
  const result = validateWorkbenchSnapshot(
    duplicateNodeIDWorkbenchSnapshotFixture
  );

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "nodes[1].id"));
});

test("rejects invalid display mode from canonical contract fixtures", () => {
  const result = validateWorkbenchSnapshot(
    invalidDisplayModeWorkbenchSnapshotFixture
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].displayMode")
  );
});

test("rejects invalid frame size from canonical contract fixtures", () => {
  const result = validateWorkbenchSnapshot(
    invalidFrameWorkbenchSnapshotFixture
  );

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].frame.width")
  );
  assert.ok(
    result.issues.some((issue) => issue.path === "nodes[0].frame.height")
  );
});

test("rejects oversized snapshots from canonical contract fixtures", () => {
  const result = validateWorkbenchSnapshot(oversizedWorkbenchSnapshotFixture);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "snapshot"));
});
