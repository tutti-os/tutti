import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";

export interface DisposableAgentOutcomeNotificationController {
  dispose(): void;
}

export function resolveFusionDockAgentNotificationWorkspaceIds(input: {
  currentWorkspaceId: string;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
}): string[] {
  const workspaceIds = new Set<string>();
  addWorkspaceId(workspaceIds, input.currentWorkspaceId);
  for (const resource of input.resources) {
    if (resource.kind === "agent" && resource.category === "background-task") {
      addWorkspaceId(workspaceIds, resource.workspaceId);
    }
  }
  for (const window of input.windows) {
    if (window.kind === "agent") {
      addWorkspaceId(workspaceIds, window.workspaceId);
    }
  }
  return [...workspaceIds].sort();
}

export function reconcileFusionDockAgentOutcomeNotificationControllers(input: {
  controllers: Map<string, DisposableAgentOutcomeNotificationController>;
  createController(
    workspaceId: string
  ): DisposableAgentOutcomeNotificationController;
  workspaceIds: readonly string[];
}): void {
  const nextWorkspaceIds = new Set(
    input.workspaceIds.map((workspaceId) => workspaceId.trim()).filter(Boolean)
  );
  for (const [workspaceId, controller] of input.controllers) {
    if (!nextWorkspaceIds.has(workspaceId)) {
      controller.dispose();
      input.controllers.delete(workspaceId);
    }
  }
  for (const workspaceId of nextWorkspaceIds) {
    if (!input.controllers.has(workspaceId)) {
      input.controllers.set(workspaceId, input.createController(workspaceId));
    }
  }
}

export function disposeFusionDockAgentOutcomeNotificationControllers(
  controllers: Map<string, DisposableAgentOutcomeNotificationController>
): void {
  for (const controller of controllers.values()) {
    controller.dispose();
  }
  controllers.clear();
}

function addWorkspaceId(workspaceIds: Set<string>, value: string): void {
  const workspaceId = value.trim();
  if (workspaceId) {
    workspaceIds.add(workspaceId);
  }
}
