import { BrowserWindow, app, type WebContents } from "electron";
import {
  desktopIpcChannels,
  type DesktopHostNotificationNavigationPayload,
  type DesktopHostNotificationPayload
} from "../../shared/contracts/ipc";
import type { WorkspaceLaunch } from "../host/workspaceLaunch";
import { createDesktopNotificationActivation } from "../host/desktopNotificationActivation.ts";
import { createElectronDesktopNotificationAccess } from "../host/electronDesktopNotificationAccess.ts";
import { getDesktopLogger } from "../logging.ts";
import { registerDesktopIpcHandler } from "./handle";

export interface HostNotificationsIpcDependencies {
  workspaceLaunch: Pick<WorkspaceLaunch, "openStartupWindow">;
}

export function registerHostNotificationsIpc(
  deps: HostNotificationsIpcDependencies
): void {
  const logger = getDesktopLogger();
  const activation = createDesktopNotificationActivation({
    focusApp() {
      app.focus();
    },
    getWindows() {
      return BrowserWindow.getAllWindows();
    },
    onOpenStartupWindowFailed(error) {
      logger.warn("failed to open startup window from desktop notification", {
        error
      });
    },
    openStartupWindow() {
      return deps.workspaceLaunch.openStartupWindow();
    }
  });
  const access = createElectronDesktopNotificationAccess(logger);

  registerDesktopIpcHandler(
    desktopIpcChannels.host.notifications.show,
    (event, payload: DesktopHostNotificationPayload) => {
      const navigation = payload.navigation;
      const sender = event.sender;
      return access.show({
        body: payload.body,
        title: payload.title,
        onClick: navigation
          ? () => {
              sendNotificationNavigate(sender, navigation);
            }
          : () => {
              void activation.activate();
            }
      });
    }
  );
}

function sendNotificationNavigate(
  sender: WebContents,
  navigation: DesktopHostNotificationNavigationPayload
): void {
  if (sender.isDestroyed()) {
    return;
  }
  const window = BrowserWindow.fromWebContents(sender);
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  sender.send(desktopIpcChannels.host.notifications.navigate, navigation);
}
