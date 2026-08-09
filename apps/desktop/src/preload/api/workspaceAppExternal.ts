import {
  desktopIpcChannels,
  type DesktopWorkspaceAppExternalRendererEvent,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse
} from "../../shared/contracts/ipc.ts";
import type {
  DesktopWorkspaceAppExternalHostApi,
  DesktopWorkspaceAppExternalHostRequestResult
} from "../types.ts";
import electron, { type IpcRendererEvent } from "electron";

const { ipcRenderer } = electron;

interface WorkspaceAppExternalIpcRenderer {
  off(
    channel: string,
    listener: (
      event: IpcRendererEvent,
      request: DesktopWorkspaceAppExternalRendererRequest
    ) => void
  ): void;
  on(
    channel: string,
    listener: (
      event: IpcRendererEvent,
      request: DesktopWorkspaceAppExternalRendererRequest
    ) => void
  ): void;
  send(channel: string, payload: unknown): void;
}

export function createWorkspaceAppExternalDesktopApi(
  renderer: WorkspaceAppExternalIpcRenderer = ipcRenderer
): DesktopWorkspaceAppExternalHostApi {
  return {
    onRequest(listener) {
      let disposed = false;
      let announcedReady = false;
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

      renderer.on(desktopIpcChannels.appExternal.rendererRequest, handler);
      queueMicrotask(() => {
        if (disposed) {
          return;
        }
        announcedReady = true;
        renderer.send(desktopIpcChannels.appExternal.rendererReady, {
          ready: true
        });
      });
      return () => {
        disposed = true;
        renderer.off(desktopIpcChannels.appExternal.rendererRequest, handler);
        if (announcedReady) {
          renderer.send(desktopIpcChannels.appExternal.rendererReady, {
            ready: false
          });
        }
      };
    },
    sendEvent(event: DesktopWorkspaceAppExternalRendererEvent) {
      renderer.send(desktopIpcChannels.appExternal.rendererEvent, event);
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
