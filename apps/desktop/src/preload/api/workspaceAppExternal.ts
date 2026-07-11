import {
  desktopIpcChannels,
  type DesktopWorkspaceAppExternalRendererEvent,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse
} from "../../shared/contracts/ipc";
import type {
  DesktopWorkspaceAppExternalHostApi,
  DesktopWorkspaceAppExternalHostRequestResult
} from "../types";
import { ipcRenderer, type IpcRendererEvent } from "electron";
import { normalizeDesktopApiErrorDetails } from "../../shared/desktopApiError.ts";

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
    },
    sendEvent(event: DesktopWorkspaceAppExternalRendererEvent) {
      ipcRenderer.send(desktopIpcChannels.appExternal.rendererEvent, event);
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
      error: normalizeDesktopApiErrorDetails(error)
    }
  };
  ipcRenderer.send(desktopIpcChannels.appExternal.rendererResponse, response);
}
