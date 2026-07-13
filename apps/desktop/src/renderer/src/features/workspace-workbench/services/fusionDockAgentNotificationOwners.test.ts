import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import {
  reconcileFusionDockAgentOutcomeNotificationControllers,
  resolveFusionDockAgentNotificationWorkspaceIds
} from "./fusionDockAgentNotificationOwners.ts";

test("Fusion Dock notification owners cover current and active Agent workspaces", () => {
  assert.deepEqual(
    resolveFusionDockAgentNotificationWorkspaceIds({
      currentWorkspaceId: "workspace-1",
      resources: [
        agentResource("workspace-2"),
        {
          ...agentResource("workspace-recoverable"),
          canStop: false,
          category: "recoverable-session",
          status: "completed"
        }
      ],
      windows: [agentWindow("workspace-3"), browserWindow("workspace-4")]
    }),
    ["workspace-1", "workspace-2", "workspace-3"]
  );
});

test("Fusion Dock outcome controllers add, retain, and dispose workspace owners", () => {
  const created: string[] = [];
  const disposed: string[] = [];
  const controllers = new Map();
  const createController = (workspaceId: string) => {
    created.push(workspaceId);
    return { dispose: () => disposed.push(workspaceId) };
  };

  reconcileFusionDockAgentOutcomeNotificationControllers({
    controllers,
    createController,
    workspaceIds: ["workspace-1", "workspace-2"]
  });
  reconcileFusionDockAgentOutcomeNotificationControllers({
    controllers,
    createController,
    workspaceIds: ["workspace-2", "workspace-3"]
  });
  reconcileFusionDockAgentOutcomeNotificationControllers({
    controllers,
    createController,
    workspaceIds: ["workspace-2", "workspace-3"]
  });

  assert.deepEqual(created, ["workspace-1", "workspace-2", "workspace-3"]);
  assert.deepEqual(disposed, ["workspace-1"]);
  assert.deepEqual([...controllers.keys()], ["workspace-2", "workspace-3"]);
});

function agentResource(workspaceId: string): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: true,
    category: "background-task",
    id: "agent-1",
    kind: "agent",
    provider: "codex",
    status: "waiting",
    subtitle: null,
    title: "Agent",
    updatedAtUnixMs: 1,
    workspaceId,
    workspaceName: workspaceId
  };
}

function agentWindow(workspaceId: string): DesktopFusionWindowDescriptor {
  return { ...browserWindow(workspaceId), kind: "agent" };
}

function browserWindow(workspaceId: string): DesktopFusionWindowDescriptor {
  return {
    createdAtUnixMs: 1,
    focused: false,
    kind: "browser",
    lastFocusedAtUnixMs: 1,
    resourceId: null,
    title: null,
    visibility: "visible",
    windowInstanceId: `${workspaceId}:window`,
    workspaceId
  };
}
