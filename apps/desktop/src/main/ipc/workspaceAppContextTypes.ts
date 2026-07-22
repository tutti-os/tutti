import type { BrowserWindow } from "electron";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";

export interface WorkspaceAppGuestContext {
  appID: string;
  launchIntent?: TuttiExternalWorkspaceOpenRouteIntent;
  ownerWindow: BrowserWindow;
  workspaceID: string;
}
