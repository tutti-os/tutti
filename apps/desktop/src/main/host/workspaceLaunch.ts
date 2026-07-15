import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopAgentDirectorySnapshot } from "../../shared/contracts/agentDirectory.ts";
import type { DesktopAgentProviderStatusSnapshot } from "../../shared/contracts/ipc.ts";

export interface WorkspaceLaunchOwnerWindow {
  close(): void;
  destroy?(): void;
}

export interface WorkspaceLaunchAdapters {
  showAgentWindow(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  showWorkspaceWindow(
    workspaceID: string,
    options?: WorkspaceLaunchWorkspaceWindowOptions
  ): Promise<WorkspaceLaunchOwnerWindow | null | void>;
  warnStartupWindowResolutionFailure(error: unknown): void;
}

export interface WorkspaceLaunchWorkspaceWindowOptions {
  windowKind?: "agent" | "workspace";
}

export interface WorkspaceLaunchAgentWindowInput {
  agentDirectorySnapshot?: DesktopAgentDirectorySnapshot | null;
  agentSessionID?: string | null;
  agentTargetID?: string | null;
  autoSubmit?: boolean;
  draftPrompt?: string | null;
  openerBounds?: Electron.Rectangle | null;
  openerWindowKind?: "agent" | "workspace" | null;
  offsetFromSourceWindow?: boolean;
  providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot | null;
  provider?: string | null;
  userProjectPath?: string | null;
  workspaceID: string;
}

export interface WorkspaceLaunch {
  openStartupWindow(): Promise<void>;
  showAgentWindow(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  showWorkspace(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string
  ): Promise<void>;
  replaceWorkspaceWindow(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string,
    windowKind: "agent" | "workspace"
  ): Promise<void>;
}

export interface WorkspaceLaunchDependencies {
  adapters: WorkspaceLaunchAdapters;
  tuttidClient: Pick<TuttidClient, "getStartupWorkspace">;
}

export function createWorkspaceLaunch(
  deps: WorkspaceLaunchDependencies
): WorkspaceLaunch {
  return {
    async openStartupWindow() {
      try {
        const workspaceID = await resolveStartupWorkspaceID();
        await deps.adapters.showWorkspaceWindow(workspaceID);
      } catch (error) {
        deps.adapters.warnStartupWindowResolutionFailure(error);
        throw error;
      }
    },

    showAgentWindow(input) {
      return deps.adapters.showAgentWindow(input);
    },
    showWorkspace,
    replaceWorkspaceWindow
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
    const workspaceWindow =
      await deps.adapters.showWorkspaceWindow(workspaceID);
    if (workspaceWindow === ownerWindow) {
      return;
    }
    forceCloseWindow(ownerWindow);
  }

  async function replaceWorkspaceWindow(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string,
    windowKind: "agent" | "workspace"
  ): Promise<void> {
    const workspaceWindow = await deps.adapters.showWorkspaceWindow(
      workspaceID,
      {
        windowKind
      }
    );
    if (workspaceWindow === ownerWindow) {
      return;
    }
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
