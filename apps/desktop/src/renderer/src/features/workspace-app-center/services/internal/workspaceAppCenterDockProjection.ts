import type {
  WorkbenchHostDockEntry,
  WorkbenchHostDockEntryState
} from "@tutti-os/workbench-surface";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";

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
    .map((app) => {
      const status = app.runtimeStatus;
      const launchUrl = app.launchUrl;
      const installed = app.installed;
      let projection: Pick<
        WorkspaceAppCenterDockProjection,
        "clickBehavior" | "launchEnabled" | "state"
      >;

      if (status === "installing") {
        projection = {
          launchEnabled: false,
          state: { kind: "loading" }
        };
      } else if (!installed) {
        projection = {
          launchEnabled: false,
          state: { kind: "disabled" }
        };
      } else if (status === "idle") {
        projection = {
          launchEnabled: true,
          state: { kind: "enabled" }
        };
      } else if (status === "installed_pending_restart") {
        projection = {
          clickBehavior: "launch",
          launchEnabled: true,
          state: { kind: "enabled" }
        };
      } else if (status === "running") {
        projection = launchUrl
          ? {
              launchEnabled: true,
              state: { kind: "enabled" }
            }
          : {
              launchEnabled: false,
              state: {
                kind: "disabled",
                reason: "missing-url"
              }
            };
      } else if (
        status === "preparing" ||
        status === "starting" ||
        status === "stopping"
      ) {
        projection = {
          launchEnabled: false,
          state: { kind: "loading" }
        };
      } else if (status === "failed" || status === "unavailable") {
        projection = {
          launchEnabled: false,
          state: { kind: "unavailable" }
        };
      } else {
        projection = {
          launchEnabled: false,
          state: { kind: "disabled" }
        };
      }

      return {
        app,
        ...projection
      };
    });
}
