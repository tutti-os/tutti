import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopFusionWindowCoordinator } from "../windows/fusionWindowCoordinator.ts";

export interface WorkspaceLaunchOwnerWindow {
  close(): void;
  destroy?(): void;
}

export interface WorkspaceLaunchAdapters {
  showAgentWindow(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  showWorkspaceWindow(workspaceID: string): Promise<void>;
  warnStartupWindowResolutionFailure(error: unknown): void;
}

export interface WorkspaceLaunchAgentWindowInput {
  launchPayload?: unknown;
  resourceID?: string | null;
  workspaceID: string;
}

export interface WorkspaceLaunch {
  openStartupWindow(): Promise<void>;
  showAgentWindow(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  showWorkspace(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string
  ): Promise<void>;
}

export interface WorkspaceLaunchDependencies {
  adapters: WorkspaceLaunchAdapters;
  fusion?: DesktopFusionWindowCoordinator;
  tuttidClient: Pick<TuttidClient, "getStartupWorkspace">;
}

export function createWorkspaceLaunch(
  deps: WorkspaceLaunchDependencies
): WorkspaceLaunch {
  return {
    async openStartupWindow() {
      try {
        const workspaceID = await resolveStartupWorkspaceID();
        if (deps.fusion?.isActive()) {
          await deps.fusion.start(workspaceID);
          return;
        }
        await deps.adapters.showWorkspaceWindow(workspaceID);
      } catch (error) {
        deps.adapters.warnStartupWindowResolutionFailure(error);
        throw error;
      }
    },

    async showAgentWindow(input) {
      if (deps.fusion?.isActive()) {
        await deps.fusion.openWindow({
          forceNew: true,
          kind: "agent",
          launchPayload: input.launchPayload,
          resourceId: input.resourceID,
          workspaceId: input.workspaceID
        });
        return;
      }
      return deps.adapters.showAgentWindow(input);
    },
    showWorkspace
  };

  async function resolveStartupWorkspaceID(): Promise<string> {
    const workspaceToRestore = await deps.tuttidClient.getStartupWorkspace();
    if (!workspaceToRestore) {
      throw new Error("tuttid did not return a startup workspace");
    }
    return workspaceToRestore.id;
  }

  async function showWorkspace(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string
  ): Promise<void> {
    if (deps.fusion?.isActive()) {
      await deps.fusion.start(workspaceID);
      await deps.fusion.showDock();
      forceCloseWindow(ownerWindow);
      return;
    }
    await deps.adapters.showWorkspaceWindow(workspaceID);
    forceCloseWindow(ownerWindow);
  }
}

function forceCloseWindow(
  ownerWindow: WorkspaceLaunchOwnerWindow | null
): void {
  if (!ownerWindow) {
    return;
  }

  if (typeof ownerWindow.destroy === "function") {
    ownerWindow.destroy();
    return;
  }

  ownerWindow.close();
}
