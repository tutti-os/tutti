import { workbenchSnapshotLimits } from "./limits.ts";
import {
  workbenchSnapshotSchemaVersion,
  type WorkbenchSnapshotV1
} from "./types.ts";

export const tuttiWorkbenchSnapshotFixture: WorkbenchSnapshotV1 = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [
    {
      id: "workspace-overview",
      kind: "workspaceOverview",
      title: "Workspace",
      frame: { x: 48, y: 48, width: 760, height: 520 },
      displayMode: "floating",
      restoreFrame: null,
      isMinimized: false,
      data: { workspaceID: "workspace-1" }
    }
  ],
  nodeStack: ["workspace-overview"],
  activeNodeId: "workspace-overview"
};

export const minimalWorkbenchSnapshotFixture: WorkbenchSnapshotV1 = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [],
  nodeStack: [],
  activeNodeId: null
};

export const workbenchSnapshotWithSpacesFixture: WorkbenchSnapshotV1 = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [
    {
      id: "workspace-files",
      kind: "workspaceFiles",
      title: "Files",
      frame: { x: 12, y: 18, width: 400, height: 320 },
      displayMode: "fullscreen",
      restoreFrame: { x: 24, y: 30, width: 420, height: 340 },
      isMinimized: true,
      data: { workspaceID: "workspace-1" },
      adapterState: {
        reactFlow: {
          type: "workspaceFilesNode",
          measured: { width: 400, height: 320 }
        }
      }
    }
  ],
  nodeStack: ["workspace-files"],
  activeNodeId: "workspace-files",
  spaces: [
    {
      id: "space-1",
      name: "Primary",
      nodeIds: ["workspace-files"],
      frame: { x: 40, y: 48, width: 640, height: 480 },
      data: { layout: "single" }
    }
  ],
  activeSpaceId: "space-1",
  layoutBasis: {
    surfaceSize: { width: 1440, height: 900 },
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 0,
      safeArea: { top: 52, right: 0, bottom: 88, left: 0 }
    }
  },
  metadata: {
    initialized: true
  }
};

export const duplicateNodeIDWorkbenchSnapshotFixture: WorkbenchSnapshotV1 = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [
    {
      id: "duplicate-node",
      kind: "terminal",
      title: "First",
      frame: { x: 0, y: 0, width: 320, height: 240 }
    },
    {
      id: "duplicate-node",
      kind: "workspaceOverview",
      title: "Second",
      frame: { x: 40, y: 40, width: 360, height: 260 }
    }
  ]
};

export const invalidDisplayModeWorkbenchSnapshotFixture = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [
    {
      id: "node-1",
      kind: "terminal",
      title: "Terminal",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      displayMode: "tabbed"
    }
  ]
} as const;

export const invalidFrameWorkbenchSnapshotFixture = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [
    {
      id: "node-1",
      kind: "terminal",
      title: "Terminal",
      frame: {
        x: 0,
        y: 0,
        width: workbenchSnapshotLimits.minFrameWidth - 1,
        height: workbenchSnapshotLimits.minFrameHeight - 1
      }
    }
  ]
} as const;

export const oversizedWorkbenchSnapshotFixture: WorkbenchSnapshotV1 = {
  schemaVersion: workbenchSnapshotSchemaVersion,
  nodes: [],
  metadata: {
    payload: "x".repeat(workbenchSnapshotLimits.maxSerializedBytes)
  }
};
