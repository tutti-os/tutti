import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess";
import type { DesktopWorkspaceAppPayload } from "../../shared/contracts/ipc";
import type { WorkspaceFileIconCacheStore } from "../host/workspaceFileIconCacheStore.ts";
import type { WorkspaceLaunch } from "../host/workspaceLaunch";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import { registerHostFilesIpc } from "./hostFiles";
import { registerHostNotificationsIpc } from "./hostNotifications";
import { registerHostPreferencesIpc } from "./hostPreferences.ts";
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
  openWorkspaceAppFolder?: (
    payload: DesktopWorkspaceAppPayload
  ) => Promise<void>;
  preferences: Pick<DesktopHostPreferencesState, "ensureInitialized">;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
  workspaceLaunch: Pick<
    WorkspaceLaunch,
    | "openStartupWindow"
    | "replaceWorkspaceWindow"
    | "showAgentWindow"
    | "showWorkspace"
  >;
}

export function registerHostIpc(deps: HostIpcDependencies): void {
  registerHostPreferencesIpc(deps.preferences);
  registerHostWindowIpc({
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
