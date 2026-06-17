import {
  desktopIpcChannels,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse
} from "../../shared/contracts/ipc";
import type {
  DesktopWorkspaceAppExternalHostApi,
  DesktopWorkspaceAppExternalHostRequestResult
} from "../types";
import { ipcRenderer, type IpcRendererEvent } from "electron";

export function createWorkspaceAppExternalDesktopApi(): DesktopWorkspaceAppExternalHostApi {
  return {
    onRequest(listener) {
      const handler = (
        _event: IpcRendererEvent,
        request: DesktopWorkspaceAppExternalRendererRequest
      ) => {
        void Promise.resolve(listener(request))
          .then((data) => {
            sendResponse(request.requestId, data);
          })
          .catch((error: unknown) => {
            sendErrorResponse(request.requestId, error);
          });
      };

      ipcRenderer.on(desktopIpcChannels.appExternal.rendererRequest, handler);
      return () => {
        ipcRenderer.off(
          desktopIpcChannels.appExternal.rendererRequest,
          handler
        );
      };
    }
  };
}

function sendResponse(
  requestId: string,
  data: DesktopWorkspaceAppExternalHostRequestResult
): void {
  const response: DesktopWorkspaceAppExternalRendererResponse = {
    requestId,
    result: {
      ok: true,
      data
    }
  };
  ipcRenderer.send(desktopIpcChannels.appExternal.rendererResponse, response);
}

function sendErrorResponse(requestId: string, error: unknown): void {
  const response: DesktopWorkspaceAppExternalRendererResponse = {
    requestId,
    result: {
      ok: false,
      error: {
        code: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error)
      }
    }
  };
  ipcRenderer.send(desktopIpcChannels.appExternal.rendererResponse, response);
}
