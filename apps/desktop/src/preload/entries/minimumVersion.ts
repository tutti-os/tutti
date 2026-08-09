import { contextBridge, ipcRenderer } from "electron";
import { createDesktopMinimumVersionApi } from "@tutti-os/desktop-update-admission/preload/minimum-version";

const minimumVersion = createDesktopMinimumVersionApi({
  invoke: (channel) => ipcRenderer.invoke(channel),
  on: (channel, listener) =>
    ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]),
  removeListener: (channel, listener) =>
    ipcRenderer.removeListener(
      channel,
      listener as Parameters<typeof ipcRenderer.removeListener>[1]
    )
});

contextBridge.exposeInMainWorld("tuttiMinimumVersion", minimumVersion);
