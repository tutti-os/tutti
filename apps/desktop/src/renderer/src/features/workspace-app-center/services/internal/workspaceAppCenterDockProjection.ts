import type { WorkbenchHostDockEntryState } from "@tutti-os/workbench-surface";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterRuntimeStatus
} from "@tutti-os/workspace-app-center";

export interface WorkspaceAppCenterDockProjection {
  app: WorkspaceAppCenterApp;
  launchEnabled: boolean;
  state?: WorkbenchHostDockEntryState;
}

export function projectWorkspaceAppCenterDockApps(
  apps: readonly WorkspaceAppCenterApp[]
): WorkspaceAppCenterDockProjection[] {
  return apps
    .filter((app) => app.enabled)
    .map((app) => ({
      app,
      ...projectWorkspaceAppCenterDockState(app.runtimeStatus, app.url)
    }));
}

export function projectWorkspaceAppCenterDockState(
  status: WorkspaceAppCenterRuntimeStatus,
  url: string | null | undefined
): Pick<WorkspaceAppCenterDockProjection, "launchEnabled" | "state"> {
  if (status === "running") {
    if (!url) {
      return {
        launchEnabled: false,
        state: {
          kind: "disabled",
          reason: "missing-url"
        }
      };
    }
    return {
      launchEnabled: true,
      state: { kind: "enabled" }
    };
  }
  if (status === "preparing" || status === "starting") {
    return {
      launchEnabled: false,
      state: { kind: "loading" }
    };
  }
  if (status === "stopping") {
    return {
      launchEnabled: false,
      state: { kind: "loading" }
    };
  }
  if (status === "failed") {
    return {
      launchEnabled: false,
      state: { kind: "unavailable" }
    };
  }
  return {
    launchEnabled: false,
    state: { kind: "disabled" }
  };
}
