import { contextBridge, ipcRenderer } from "electron";
import { createBrowserDesktopApi } from "../api/browser";
import { createComputerUseDesktopApi } from "../api/computerUse";
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
  type DesktopHostWindowLayoutPayload,
  type DesktopHostWindowMinimizeStatePayload
} from "../../shared/contracts/ipc";

const desktopApi: DesktopApi = {
  computerUse: createComputerUseDesktopApi(),
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

    if (payload.maximized) {
      document.documentElement.dataset.tuttiWindowMaximized = "true";
    } else {
      delete document.documentElement.dataset.tuttiWindowMaximized;
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

ipcRenderer.on(
  desktopIpcChannels.host.window.minimizeState,
  (_event, payload: DesktopHostWindowMinimizeStatePayload) => {
    window.dispatchEvent(
      new CustomEvent<DesktopHostWindowMinimizeStatePayload>(
        "tutti-host-window-minimize",
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
