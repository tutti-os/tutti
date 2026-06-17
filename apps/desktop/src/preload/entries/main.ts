import { contextBridge, ipcRenderer } from "electron";
import { createBrowserDesktopApi } from "../api/browser";
import { createDeveloperDesktopApi } from "../api/developer";
import { createDockPreviewCacheDesktopApi } from "../api/dockPreviewCache";
import { createHostDesktopApi } from "../api/host";
import { createPlatformDesktopApi } from "../api/platform";
import { createRuntimeDesktopApi } from "../api/runtime";
import { createUpdateDesktopApi } from "../api/update";
import { createWallpaperDesktopApi } from "../api/wallpaper";
import { createWorkspaceAppExternalDesktopApi } from "../api/workspaceAppExternal";
import type { DesktopApi } from "../types";
import {
  desktopIpcChannels,
  type DesktopHostWindowLayoutPayload
} from "../../shared/contracts/ipc";

const desktopApi: DesktopApi = {
  developer: createDeveloperDesktopApi(),
  dockPreviewCache: createDockPreviewCacheDesktopApi(),
  host: createHostDesktopApi(),
  platform: createPlatformDesktopApi(),
  runtime: createRuntimeDesktopApi(),
  update: createUpdateDesktopApi(),
  wallpaper: createWallpaperDesktopApi()
};

if (isWorkspaceWindowPreload()) {
  desktopApi.browser = createBrowserDesktopApi();
  desktopApi.workspaceAppExternal = createWorkspaceAppExternalDesktopApi();
}

ipcRenderer.on(
  desktopIpcChannels.host.window.layout,
  (_event, payload: DesktopHostWindowLayoutPayload) => {
    if (payload.compactTitlebar) {
      document.documentElement.dataset.tuttiCompactTitlebar = "true";
    } else {
      delete document.documentElement.dataset.tuttiCompactTitlebar;
    }

    window.dispatchEvent(
      new CustomEvent<DesktopHostWindowLayoutPayload>(
        "tutti-host-window-layout",
        {
          detail: payload
        }
      )
    );
  }
);

contextBridge.exposeInMainWorld("tutti", desktopApi);

function isWorkspaceWindowPreload(): boolean {
  return (
    new URLSearchParams(globalThis.location.search).get("view") === "workspace"
  );
}
