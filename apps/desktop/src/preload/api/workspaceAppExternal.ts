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
import { normalizeWorkspaceAppExternalErrorDetails } from "./workspaceAppExternalError.ts";

export function createWorkspaceAppExternalDesktopApi(
  getUnknownErrorMessage: () => string
): DesktopWorkspaceAppExternalHostApi {
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
            sendErrorResponse(request.requestId, error, getUnknownErrorMessage);
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

function sendErrorResponse(
  requestId: string,
  error: unknown,
  getUnknownErrorMessage: () => string
): void {
  const response: DesktopWorkspaceAppExternalRendererResponse = {
    requestId,
    result: {
      ok: false,
      error: normalizeWorkspaceAppExternalErrorDetails(
        error,
        getUnknownErrorMessage
      )
    }
  };
  ipcRenderer.send(desktopIpcChannels.appExternal.rendererResponse, response);
}
