import { Notification } from "electron";
import { createDesktopNotificationAccess } from "./desktopNotificationAccess.ts";
import type { DesktopLogger } from "../logging.ts";

export function createElectronDesktopNotificationAccess(logger: DesktopLogger) {
  return createDesktopNotificationAccess({
    createNotification(input) {
      return new Notification(input);
    },
    isSupported() {
      return Notification.isSupported();
    },
    onFailed(error) {
      logger.warn("desktop notification failed", {
        error
      });
    }
  });
}
