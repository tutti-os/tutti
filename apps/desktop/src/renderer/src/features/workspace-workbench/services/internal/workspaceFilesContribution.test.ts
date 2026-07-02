import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { WorkspaceFileManagerPersistedState } from "@tutti-os/workspace-file-manager/services";
import type { WorkbenchHostLaunchRequest } from "@tutti-os/workbench-surface";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import type { ReporterEventInput } from "@renderer/features/analytics";
import { createWorkspaceFilesContribution } from "./workspaceFilesContribution.ts";
import { workspaceFilesNodeID } from "./workspaceWorkbenchComposition.ts";

const source = readFileSync(
  new URL("./workspaceFilesContribution.ts", import.meta.url),
  "utf8"
);
const factorySource = readFileSync(
  new URL(
    "./contributions/filesWorkbenchContributionFactory.ts",
    import.meta.url
  ),
  "utf8"
);
const renderTrafficLights = () => null;

test("workspace files window renders unified traffic lights in the custom header", () => {
  assert.match(source, /renderHeader: \(context\) =>/);
  assert.match(source, /WorkspaceFilesWorkbenchHeader/);
  assert.match(source, /renderTrafficLights\(context\)/);
  assert.match(factorySource, /WorkspaceWorkbenchTrafficLights/);
  assert.match(
    factorySource,
    /createElement\([\s\S]*WorkspaceWorkbenchTrafficLights[\s\S]*displayMode: headerContext\.displayMode[\s\S]*windowActions: headerContext\.windowActions/
  );
  assert.doesNotMatch(source, /context\.defaultActions/);
});

test("workspace files contribution exposes file manager state through runtime and snapshot node state", () => {
  const snapshotState: WorkspaceFileManagerPersistedState = {
    currentDirectoryPath: "/workspace/docs",
    navigationBackStack: ["/workspace"],
    navigationForwardStack: [],
    selectedLocationId: null,
    schemaVersion: 3
  };
  const service = createFileManagerServiceStub(snapshotState);
  const contribution = createWorkspaceFilesContribution({
    filesLabel: "Files",
    icon: null,
    renderFilesNodeBody: () => null,
    renderTrafficLights,
    workspaceFileManagerService: service,
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    contribution.externalStateSource?.getNodeState({
      instanceId: workspaceFilesNodeID,
      nodeId: workspaceFilesNodeID,
      typeId: workspaceFilesNodeID,
      workspaceId: "workspace-1"
    }),
    snapshotState
  );
  assert.deepEqual(
    contribution.externalStateSource?.getSnapshotNodeState?.({
      instanceId: workspaceFilesNodeID,
      nodeId: workspaceFilesNodeID,
      typeId: workspaceFilesNodeID,
      workspaceId: "workspace-1"
    }),
    snapshotState
  );
  assert.equal(
    contribution.externalStateSource?.getNodeState({
      instanceId: "browser",
      nodeId: "browser",
      typeId: "browser",
      workspaceId: "workspace-1"
    }),
    null
  );

  let notified = false;
  const dispose = contribution.externalStateSource?.subscribe?.(() => {
    notified = true;
  });
  service.emit();
  assert.equal(notified, true);
  dispose?.();
});

test("workspace files contribution passes restored state to the node body renderer", () => {
  const restoredState: WorkspaceFileManagerPersistedState = {
    currentDirectoryPath: "/workspace/docs",
    navigationBackStack: [],
    navigationForwardStack: ["/workspace/archive"],
    selectedLocationId: null,
    schemaVersion: 3
  };
  let capturedState: WorkspaceFileManagerPersistedState | null = null;
  const contribution = createWorkspaceFilesContribution({
    filesLabel: "Files",
    icon: null,
    renderFilesNodeBody: (context) => {
      capturedState = context.externalNodeState;
      return null;
    },
    renderTrafficLights,
    workspaceFileManagerService: createFileManagerServiceStub(null),
    workspaceId: "workspace-1"
  });

  contribution.nodes?.[0]?.renderBody({
    activation: null,
    externalNodeState: restoredState
  } as never);

  assert.deepEqual(capturedState, restoredState);
});

test("workspace files launch uses responsive cascade placement", async () => {
  const contribution = createWorkspaceFilesContribution({
    filesLabel: "Files",
    icon: null,
    renderFilesNodeBody: () => null,
    renderTrafficLights,
    workspaceFileManagerService: createFileManagerServiceStub(null),
    workspaceId: "workspace-1"
  });

  const result = await Promise.resolve(
    contribution.onLaunchRequest?.({
      ...createLaunchRequestContext(),
      reason: "dock",
      typeId: workspaceFilesNodeID,
      workspaceId: "workspace-1"
    })
  );

  assert.equal(result?.framePolicy, "cascade");
});

test("workspace files contribution reports opened from the node lease once", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const contribution = createWorkspaceFilesContribution({
    filesLabel: "Files",
    icon: null,
    renderFilesNodeBody: () => null,
    renderTrafficLights,
    reporterService: createReporterService(reporterCalls),
    workspaceFileManagerService: createFileManagerServiceStub(null),
    workspaceId: "workspace-1"
  });

  contribution.nodes?.[0]?.createLease?.({} as never);

  assert.equal(reporterCalls.length, 1);
  assert.deepEqual(reporterCalls[0], [
    {
      clientTS: reporterCalls[0]?.[0]?.clientTS,
      name: "file_manager.opened",
      params: {
        source: "restore",
        trigger: "automatic"
      }
    }
  ]);
});

function createLaunchRequestContext(): Pick<
  WorkbenchHostLaunchRequest,
  "layoutConstraints" | "surfaceSize"
> {
  return {
    layoutConstraints: {
      minHeight: 160,
      minWidth: 280,
      safeArea: {
        bottom: 79,
        left: 0,
        right: 0,
        top: 52
      },
      surfacePadding: 0
    },
    surfaceSize: {
      height: 900,
      width: 1440
    }
  };
}

function createFileManagerServiceStub(
  snapshotState: WorkspaceFileManagerPersistedState | null
): IWorkspaceFileManagerService & { emit(): void } {
  const listeners = new Set<() => void>();
  return {
    _serviceBrand: undefined,
    hostOs: "darwin",
    emit() {
      for (const listener of listeners) {
        listener();
      }
    },
    async entryExists() {
      return false;
    },
    getSession() {
      throw new Error("getSession should not be called");
    },
    getReferenceSourceAggregator() {
      throw new Error("getReferenceSourceAggregator should not be called");
    },
    getSnapshotState() {
      return snapshotState;
    },
    async openCanvasFilePreview() {
      return false;
    },
    async resolveEntryIconUrl() {
      return null;
    },
    setCanvasFilePreviewLauncher() {},
    subscribe(_workspaceID, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}
