import { app, BrowserWindow } from "electron";
import { resolveDesktopPerformanceHeadless } from "../defaults.ts";
import { getDesktopLogger } from "../logging.ts";
import {
  getWorkspaceWindowKind,
  getWorkspaceWindowWorkspaceID
} from "../windows/workspaceWindow.ts";
import { activateDesktopWindow } from "./desktopWindowActivation.ts";

export function activateBrowserAutomationHost(
  sender: Electron.WebContents
): void {
  if (resolveDesktopPerformanceHeadless()) {
    return;
  }
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  if (
    !ownerWindow ||
    ownerWindow.isDestroyed() ||
    !getWorkspaceWindowKind(ownerWindow)
  ) {
    return;
  }

  const logger = getDesktopLogger();
  const windowKind = getWorkspaceWindowKind(ownerWindow);
  try {
    activateDesktopWindow(app, ownerWindow);
    logger.info("Browser automation host activated", {
      windowKind,
      workspaceId: getWorkspaceWindowWorkspaceID(ownerWindow)
    });
  } catch (error) {
    logger.warn?.("failed to activate Browser automation host", {
      error,
      windowKind
    });
  }
}
