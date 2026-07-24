import path from "node:path";
import { app } from "electron";
import { createWorkbenchDockPreviewCacheStore } from "@tutti-os/workbench-electron";
import {
  desktopIpcChannels,
  type DesktopReadDockPreviewInput,
  type DesktopWriteDockPreviewInput
} from "../../shared/contracts/ipc";
import { getDesktopLogger } from "../logging";
import { registerDesktopIpcHandler } from "./handle";

export function registerDockPreviewCacheIpc(): void {
  const logger = getDesktopLogger();
  const store = createWorkbenchDockPreviewCacheStore({
    directory: path.join(app.getPath("userData"), "workspace-dock-previews")
  });

  registerDesktopIpcHandler(
    desktopIpcChannels.dockPreviewCache.read,
    (_event, payload: DesktopReadDockPreviewInput) => store.read(payload.key)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.dockPreviewCache.write,
    (_event, payload: DesktopWriteDockPreviewInput) => {
      void store.write(payload).catch((error) => {
        logger.warn("workspace dock preview cache write failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  );
}
