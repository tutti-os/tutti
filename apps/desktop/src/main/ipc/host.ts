import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess";
import type { DesktopWorkspaceAppPayload } from "../../shared/contracts/ipc";
import type { WorkspaceFileIconCacheStore } from "../host/workspaceFileIconCacheStore.ts";
import type { WorkspaceLaunch } from "../host/workspaceLaunch";
import type { DesktopFusionWindowCoordinator } from "../windows/fusionWindowCoordinator.ts";
import { registerHostFilesIpc } from "./hostFiles";
import { registerHostNotificationsIpc } from "./hostNotifications";
import { registerHostWindowIpc } from "./hostWindow";
import { registerHostWorkspaceIpc } from "./hostWorkspace";

export interface HostIpcDependencies {
  fileDialogs: Pick<
    DesktopFileDialogAccess,
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
    | "selectDirectory"
    | "selectUploadFiles"
  >;
  fusion: Pick<
    DesktopFusionWindowCoordinator,
    "getRendererAccessContext" | "isActive"
  >;
  openWorkspaceAppFolder?: (
    payload: DesktopWorkspaceAppPayload
  ) => Promise<void>;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
  workspaceLaunch: Pick<
    WorkspaceLaunch,
    "openStartupWindow" | "showAgentWindow" | "showWorkspace"
  >;
}

export function registerHostIpc(deps: HostIpcDependencies): void {
  registerHostWindowIpc({
    fusion: deps.fusion,
    workspaceLaunch: deps.workspaceLaunch
  });
  registerHostNotificationsIpc({
    workspaceLaunch: deps.workspaceLaunch
  });
  registerHostWorkspaceIpc({
    openWorkspaceAppFolder: deps.openWorkspaceAppFolder,
    workspaceLaunch: deps.workspaceLaunch
  });
  registerHostFilesIpc({
    fileDialogs: deps.fileDialogs,
    workspaceFileIconCache: deps.workspaceFileIconCache
  });
}
