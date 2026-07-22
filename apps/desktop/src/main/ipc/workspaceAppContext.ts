import type { BrowserWindow, WebContents } from "electron";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences";
import type { DesktopLogger } from "../logging";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import { registerWorkspaceAppAgentActivityIpc } from "./workspaceAppAgentActivityIpc.ts";
import {
  WorkspaceAppFrontendLogWriter,
  WorkspaceAppGuestLogRateLimiter
} from "./workspaceAppFrontendLogging.ts";
import { registerWorkspaceAppFilesIpc } from "./workspaceAppFilesIpc.ts";
import { registerWorkspaceAppGuestContext } from "./workspaceAppGuestContextRegistry.ts";
import { registerWorkspaceAppShellIpc } from "./workspaceAppShellIpc.ts";
import { registerWorkspaceAppUserProjectsIpc } from "./workspaceAppUserProjectsIpc.ts";

let workspaceAppFrontendLogWriter: WorkspaceAppFrontendLogWriter | null = null;
let workspaceAppGuestLogRateLimiter: WorkspaceAppGuestLogRateLimiter | null =
  null;

export function registerWorkspaceAppGuestWebContents(
  ownerWindow: BrowserWindow,
  contents: WebContents,
  logger?: DesktopLogger,
  partition?: string | null
): void {
  registerWorkspaceAppGuestContext({
    contents,
    logger,
    onDestroyed: (webContentsId) => {
      workspaceAppGuestLogRateLimiter?.forget(webContentsId);
    },
    ownerWindow,
    partition
  });
}

export function registerWorkspaceAppContextIpc(
  endpoint: DesktopDaemonEndpoint,
  preferences: DesktopHostPreferencesState,
  options: {
    logger?: DesktopLogger;
    sessionID: string;
    stateRootDir: string;
  }
): void {
  const { logger, sessionID, stateRootDir } = options;
  workspaceAppGuestLogRateLimiter ??= new WorkspaceAppGuestLogRateLimiter();
  workspaceAppFrontendLogWriter ??= new WorkspaceAppFrontendLogWriter(
    stateRootDir,
    sessionID,
    workspaceAppGuestLogRateLimiter
  );

  registerWorkspaceAppShellIpc({
    endpoint,
    logger,
    logWriter: workspaceAppFrontendLogWriter,
    preferences
  });
  registerWorkspaceAppAgentActivityIpc({ endpoint, logger });
  registerWorkspaceAppFilesIpc({ endpoint });
  registerWorkspaceAppUserProjectsIpc();
}
