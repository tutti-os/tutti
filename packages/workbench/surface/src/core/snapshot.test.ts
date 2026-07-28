import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import {
  createWorkbenchNode,
  createWorkbenchSnapshotFromState,
  createWorkbenchStateFromSnapshot
} from "./snapshot.ts";

test("hydrates canonical workbench state from snapshot nodes", () => {
  const snapshot: WorkbenchSnapshot = {
    schemaVersion: 1,
    nodes: [
      {
        id: "workspace-files",
        kind: "workspaceFiles",
        title: "Files",
        frame: { x: 120, y: 80, width: 640, height: 480 },
        restoreFrame: null
      }
    ],
    nodeStack: ["workspace-files"]
  };

  const state = createWorkbenchStateFromSnapshot<{ workspaceID: string }>(
    snapshot
  );

  assert.deepEqual(state.nodeStack, ["workspace-files"]);
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 120,
    y: 80,
    width: 640,
    height: 480
  });
  assert.equal(state.nodes[0]?.displayMode, "floating");
  assert.equal(state.nodes[0]?.isMinimized, false);
});

test("serializes canonical workbench state back to canonical snapshot shape", () => {
  const state = {
    nodes: [
      createWorkbenchNode({
        id: "workspace-files",
        kind: "workspaceFiles",
        title: "Files",
        frame: { x: 120, y: 80, width: 640, height: 480 },
        restoreFrame: null,
        data: {
          workspaceID: "workspace-1"
        }
      })
    ],
    nodeStack: ["workspace-files"]
  };

  const snapshot = createWorkbenchSnapshotFromState(state, {
    metadata: {
      tuttiWorkbenchInitialized: true
    }
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.nodes[0]?.frame, {
    x: 120,
    y: 80,
    width: 640,
    height: 480
  });
  assert.equal(snapshot.activeNodeId, "workspace-files");
  assert.deepEqual(snapshot.metadata, {
    tuttiWorkbenchInitialized: true
  });
});

test("serializes the surface layout basis with workbench state", () => {
  const snapshot = createWorkbenchSnapshotFromState({
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    },
    nodeStack: [],
    nodes: [],
    surfaceSize: { width: 1512, height: 897 }
  });

  assert.deepEqual(snapshot.layoutBasis, {
    surfaceSize: { width: 1512, height: 897 },
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    }
  });
});

test("omits the layout basis while the measured surface is collapsed", () => {
  const snapshot = createWorkbenchSnapshotFromState({
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    },
    nodeStack: [],
    nodes: [],
    surfaceSize: { width: 0, height: 0 }
  });

  assert.equal(snapshot.layoutBasis, undefined);
});
