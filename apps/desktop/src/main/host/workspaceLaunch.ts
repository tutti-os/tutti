import type { TrackEvent, TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopAgentDirectorySnapshot } from "../../shared/contracts/agentDirectory.ts";
import type { DesktopAgentProviderStatusSnapshot } from "../../shared/contracts/ipc.ts";
import type { DesktopWorkspaceUiMode } from "../../shared/preferences/index.ts";

export interface WorkspaceLaunchOwnerWindow {
  close(): void;
  destroy?(): void;
}

export interface WorkspaceLaunchAdapters {
  ensureAgentBrowserHost(
    input: WorkspaceLaunchResolvedAgentWindowInput
  ): Promise<void>;
  showAgentWindow(
    input: WorkspaceLaunchResolvedAgentWindowInput
  ): Promise<void>;
  showWorkspaceWindow(
    workspaceID: string,
    options: WorkspaceLaunchWorkspaceWindowOptions
  ): Promise<WorkspaceLaunchOwnerWindow | null | void>;
  warnStartupWindowResolutionFailure(error: unknown): void;
}

export interface WorkspaceLaunchWorkspaceWindowOptions {
  windowKind: "agent" | "workspace";
  workspaceUiMode: DesktopWorkspaceUiMode;
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

export interface WorkspaceLaunchResolvedAgentWindowInput extends WorkspaceLaunchAgentWindowInput {
  workspaceUiMode: DesktopWorkspaceUiMode;
}

export interface WorkspaceLaunch {
  ensureAgentBrowserHost(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  ensureUserBrowserHost(workspaceID: string): Promise<void>;
  openStartupWindow(): Promise<void>;
  showAgentWindow(input: WorkspaceLaunchAgentWindowInput): Promise<void>;
  showWorkspace(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    workspaceID: string
  ): Promise<void>;
  replaceWorkspaceWindow(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    input: WorkspaceLaunchReplacementInput
  ): Promise<void>;
}

export interface WorkspaceLaunchReplacementInput {
  clientTS: number;
  mode: "agent" | "os";
  previousMode: "agent" | "os";
  workspaceID: string;
}

export interface WorkspaceLaunchDependencies {
  adapters: WorkspaceLaunchAdapters;
  getPrimaryWorkspaceWindowOptions: () => WorkspaceLaunchWorkspaceWindowOptions;
  onAnalyticsError?: (error: unknown) => void;
  tuttidClient: Pick<TuttidClient, "getStartupWorkspace" | "trackEvents">;
}

export function createWorkspaceLaunch(
  deps: WorkspaceLaunchDependencies
): WorkspaceLaunch {
  return {
    ensureAgentBrowserHost(input) {
      return deps.adapters.ensureAgentBrowserHost({
        ...input,
        workspaceUiMode: deps.getPrimaryWorkspaceWindowOptions().workspaceUiMode
      });
    },
    async ensureUserBrowserHost(workspaceID) {
      const { workspaceUiMode } = deps.getPrimaryWorkspaceWindowOptions();
      await deps.adapters.showWorkspaceWindow(workspaceID, {
        windowKind: "workspace",
        workspaceUiMode
      });
    },
    async openStartupWindow() {
      try {
        const workspaceID = await resolveStartupWorkspaceID();
        await deps.adapters.showWorkspaceWindow(
          workspaceID,
          deps.getPrimaryWorkspaceWindowOptions()
        );
      } catch (error) {
        deps.adapters.warnStartupWindowResolutionFailure(error);
        throw error;
      }
    },

    showAgentWindow(input) {
      return deps.adapters.showAgentWindow({
        ...input,
        workspaceUiMode: deps.getPrimaryWorkspaceWindowOptions().workspaceUiMode
      });
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
    const workspaceWindow = await deps.adapters.showWorkspaceWindow(
      workspaceID,
      deps.getPrimaryWorkspaceWindowOptions()
    );
    if (workspaceWindow === ownerWindow) {
      return;
    }
    forceCloseWindow(ownerWindow);
  }

  async function replaceWorkspaceWindow(
    ownerWindow: WorkspaceLaunchOwnerWindow | null,
    input: WorkspaceLaunchReplacementInput
  ): Promise<void> {
    let workspaceWindow: WorkspaceLaunchOwnerWindow | null | void;
    try {
      workspaceWindow = await deps.adapters.showWorkspaceWindow(
        input.workspaceID,
        {
          windowKind: input.mode === "agent" ? "agent" : "workspace",
          workspaceUiMode: input.mode
        }
      );
    } catch (error) {
      reportWorkspaceUiModeChanged(input);
      throw error;
    }
    reportWorkspaceUiModeChanged(input);
    if (workspaceWindow === ownerWindow) {
      return;
    }
    forceCloseWindow(ownerWindow);
  }

  function reportWorkspaceUiModeChanged(
    input: WorkspaceLaunchReplacementInput
  ): void {
    void deps.tuttidClient
      .trackEvents([createWorkspaceUiModeChangedEvent(input)])
      .catch((error) => deps.onAnalyticsError?.(error));
  }
}

export function createWorkspaceUiModeChangedEvent(
  input: WorkspaceLaunchReplacementInput
): TrackEvent {
  return {
    client_ts: input.clientTS,
    name: "settings.workspace_ui_mode_changed",
    params: {
      action: input.mode === "agent" ? "enabled" : "disabled",
      next_mode: input.mode,
      previous_mode: input.previousMode
    }
  };
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
