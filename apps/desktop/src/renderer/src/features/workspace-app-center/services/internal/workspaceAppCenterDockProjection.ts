import type {
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryState
} from "@tutti-os/workbench-surface";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterRuntimeStatus
} from "@tutti-os/workspace-app-center";

export interface WorkspaceAppCenterDockProjection {
  app: WorkspaceAppCenterApp;
  clickBehavior?: WorkbenchHostDockEntry["clickBehavior"];
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
      ...projectWorkspaceAppCenterDockState(
        app.runtimeStatus,
        app.launchUrl,
        app.installed
      )
    }));
}

export function projectWorkspaceAppCenterDockState(
  status: WorkspaceAppCenterRuntimeStatus,
  launchUrl: string | null | undefined,
  installed = true
): Pick<
  WorkspaceAppCenterDockProjection,
  "clickBehavior" | "launchEnabled" | "state"
> {
  if (status === "installing") {
    return {
      launchEnabled: false,
      state: { kind: "loading" }
    };
  }
  if (!installed) {
    return {
      launchEnabled: false,
      state: { kind: "disabled" }
    };
  }
  if (status === "idle") {
    return {
      launchEnabled: true,
      state: { kind: "enabled" }
    };
  }
  if (status === "installed_pending_restart") {
    return {
      clickBehavior: "launch",
      launchEnabled: true,
      state: { kind: "enabled" }
    };
  }
  if (status === "running") {
    if (!launchUrl) {
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
  if (status === "failed" || status === "unavailable") {
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
