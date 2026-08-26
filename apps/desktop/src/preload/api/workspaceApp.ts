import electron, { type IpcRendererEvent } from "electron";
import {
  desktopIpcChannels,
  type DesktopWorkspaceAppPopupRejectedEvent
} from "../../shared/contracts/ipc.ts";
import type { DesktopWorkspaceAppApi } from "../types.ts";

const { ipcRenderer } = electron;

interface WorkspaceAppIpcRenderer {
  off(
    channel: string,
    listener: (
      event: IpcRendererEvent,
      payload: DesktopWorkspaceAppPopupRejectedEvent
    ) => void
  ): void;
  on(
    channel: string,
    listener: (
      event: IpcRendererEvent,
      payload: DesktopWorkspaceAppPopupRejectedEvent
    ) => void
  ): void;
}

export function createWorkspaceAppDesktopApi(
  renderer: WorkspaceAppIpcRenderer = ipcRenderer
): DesktopWorkspaceAppApi {
  return {
    onPopupRejected(listener) {
      const handleRejected = (
        _event: IpcRendererEvent,
        payload: DesktopWorkspaceAppPopupRejectedEvent
      ) => {
        listener(payload);
      };
      renderer.on(
        desktopIpcChannels.workspaceApp.popupRejected,
        handleRejected
      );
      return () => {
        renderer.off(
          desktopIpcChannels.workspaceApp.popupRejected,
          handleRejected
        );
      };
    }
  };
}
