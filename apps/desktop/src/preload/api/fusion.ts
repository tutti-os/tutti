import { ipcRenderer, type IpcRendererEvent } from "electron";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import type { DesktopFusionApi } from "../types.ts";
import { invokeDesktopApi } from "./invoke.ts";

export function createFusionDesktopApi(): DesktopFusionApi {
  return {
    closeWindow(input) {
      return invokeDesktopApi(desktopIpcChannels.fusion.closeWindow, input);
    },
    focusWindow(input) {
      return invokeDesktopApi(desktopIpcChannels.fusion.focusWindow, input);
    },
    getState() {
      return invokeDesktopApi(desktopIpcChannels.fusion.getState);
    },
    hideDock() {
      return invokeDesktopApi(desktopIpcChannels.fusion.hideDock);
    },
    openWindow(input) {
      return invokeDesktopApi(desktopIpcChannels.fusion.openWindow, input);
    },
    onState(listener) {
      const handler = (_event: IpcRendererEvent, state: unknown) => {
        listener(state as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(desktopIpcChannels.fusion.state, handler);
      return () => {
        ipcRenderer.removeListener(desktopIpcChannels.fusion.state, handler);
      };
    },
    showDock() {
      return invokeDesktopApi(desktopIpcChannels.fusion.showDock);
    },
    toggleDock() {
      return invokeDesktopApi(desktopIpcChannels.fusion.toggleDock);
    },
    updateWindow(input) {
      return invokeDesktopApi(desktopIpcChannels.fusion.updateWindow, input);
    }
  };
}
