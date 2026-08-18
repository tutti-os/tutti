import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences";
import type { WorkspaceLaunch } from "../host/workspaceLaunch";
import { registerDeveloperIpc } from "./developer";
import { registerHostIpc } from "./host";
import { registerRuntimeIpc } from "./runtime";
import { registerUpdateIpc } from "./update";
import { registerWallpaperIpc } from "./wallpaper";
import { registerWorkspaceAppContextIpc } from "./workspaceAppContext";
import type { AppUpdateService } from "../update/appUpdateService";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import { registerBrowserIpc } from "./browser";
import { registerComputerUseIpc } from "./computerUse";
import { registerDockPreviewCacheIpc } from "./dockPreviewCache";
import { getDesktopLogSessionID, type DesktopLogger } from "../logging";
import { resolveDesktopDefaultsFromEnv } from "../defaults";
import type { WorkspaceFileIconCacheStore } from "../host/workspaceFileIconCacheStore.ts";
import type { DesktopWorkspaceAppPayload } from "../../shared/contracts/ipc";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";

export interface IpcRegistrationDependencies {
  daemonEndpoint: DesktopDaemonEndpoint;
  fileDialogs: Pick<
    DesktopFileDialogAccess,
    | "selectAppArchive"
    | "selectAppArchiveExportPath"
    | "selectAppIconImage"
    | "selectDirectory"
    | "selectUploadFiles"
  >;
  logger: DesktopLogger;
  tuttidClient: Pick<
    TuttidClient,
    | "listWorkspaceAgentSessionMessages"
    | "listWorkspaceAgentSessions"
    | "readWorkspaceAgentSessionAttachment"
    | "listWorkspaceAppFactoryJobs"
    | "listWorkspaceApps"
    | "listWorkspaces"
    | "getAgentSessionReplayTransportPlayback"
    | "importAgentSessionCassettes"
    | "prepareAgentSessionReplayWorkspace"
    | "updateAgentSessionReplayTransportPlayback"
  >;
  openWorkspaceAppFolder?: (
    payload: DesktopWorkspaceAppPayload
  ) => Promise<void>;
  preferences: DesktopHostPreferencesState;
  workspaceFileIconCache?: WorkspaceFileIconCacheStore;
  updateService: AppUpdateService;
  workspaceLaunch: Pick<
    WorkspaceLaunch,
    | "ensureAgentBrowserHost"
    | "ensureUserBrowserHost"
    | "openStartupWindow"
    | "replaceWorkspaceWindow"
    | "showAgentWindow"
    | "showWorkspace"
  >;
}

export async function registerIpcHandlers(
  deps: IpcRegistrationDependencies
): Promise<readonly { dispose(): void; shutdown?(): Promise<void> }[]> {
  registerWorkspaceAppContextIpc(deps.daemonEndpoint, deps.preferences, {
    logger: deps.logger,
    sessionID: getDesktopLogSessionID(),
    stateRootDir: resolveDesktopDefaultsFromEnv().state.rootDir
  });
  const browserAutomation = await registerBrowserIpc(deps.preferences, {
    ensureAgentBrowserHost: ({ agentSessionId, workspaceId }) =>
      deps.workspaceLaunch.ensureAgentBrowserHost({
        agentSessionID: agentSessionId,
        workspaceID: workspaceId
      }),
    ensureUserBrowserHost: ({ workspaceId }) =>
      deps.workspaceLaunch.ensureUserBrowserHost(workspaceId)
  });
  registerComputerUseIpc();
  registerDockPreviewCacheIpc();
  registerDeveloperIpc(deps.preferences, deps.tuttidClient);
  const runtime = registerRuntimeIpc(
    deps.daemonEndpoint,
    deps.logger,
    deps.tuttidClient,
    deps.fileDialogs,
    deps.preferences
  );
  registerUpdateIpc(deps.updateService);
  registerWallpaperIpc();
  registerHostIpc({
    fileDialogs: deps.fileDialogs,
    openWorkspaceAppFolder: deps.openWorkspaceAppFolder,
    preferences: deps.preferences,
    workspaceFileIconCache: deps.workspaceFileIconCache,
    workspaceLaunch: deps.workspaceLaunch
  });
  return [browserAutomation, runtime];
}
