import electron, { type IpcMainEvent } from "electron";
import {
  desktopIpcChannels,
  type DesktopIpcResult,
  type DesktopWorkspaceAppExternalRendererRequest,
  type DesktopWorkspaceAppExternalRendererResponse,
  type DesktopWorkspaceAppExternalRendererResult
} from "../../shared/contracts/ipc.ts";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";

const { ipcMain } = electron;

export function requestWorkspaceAppExternalRenderer<
  TResult extends DesktopWorkspaceAppExternalRendererResult
>(
  context: WorkspaceAppGuestContext,
  request: DesktopWorkspaceAppExternalRendererRequest
): Promise<TResult> {
  const ownerWebContents = context.ownerWindow.webContents;
  if (ownerWebContents.isDestroyed()) {
    throw new Error("Workspace owner renderer is unavailable.");
  }

  return new Promise<TResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Workspace app external request timed out."));
    }, 30_000);

    const handleResponse = (event: IpcMainEvent, payload: unknown): void => {
      if (event.sender.id !== ownerWebContents.id) {
        return;
      }
      if (!isWorkspaceAppExternalRendererResponse(payload, request.requestId)) {
        return;
      }
      cleanup();
      if (payload.result.ok) {
        resolve(payload.result.data as TResult);
        return;
      }
      reject(new Error(payload.result.error.message));
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      ipcMain.off(
        desktopIpcChannels.appExternal.rendererResponse,
        handleResponse
      );
    };

    ipcMain.on(desktopIpcChannels.appExternal.rendererResponse, handleResponse);
    ownerWebContents.send(
      desktopIpcChannels.appExternal.rendererRequest,
      request
    );
  });
}

export function isWorkspaceAppExternalRendererResponse(
  value: unknown,
  requestId: string
): value is DesktopWorkspaceAppExternalRendererResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { requestId?: unknown }).requestId === requestId &&
    isDesktopIpcResult((value as { result?: unknown }).result)
  );
}

function isDesktopIpcResult(
  value: unknown
): value is DesktopIpcResult<DesktopWorkspaceAppExternalRendererResult> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ok = (value as { ok?: unknown }).ok;
  if (ok === true) {
    return "data" in value;
  }
  return (
    ok === false &&
    typeof (value as { error?: { message?: unknown } }).error?.message ===
      "string"
  );
}
